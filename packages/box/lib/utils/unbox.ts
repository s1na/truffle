import fse from "fs-extra";
import path from "path";
import download from "download-git-repo";
import axios from "axios";
import vcsurl from "vcsurl";
import { parse as parseURL } from "url";
import { execSync } from "child_process";
import inquirer from "inquirer";
import type { unboxOptions, boxConfig, boxConfigRecipeSpecMv } from "typings";
import { promisify } from "util";
import ignore from "ignore";

function verifyLocalPath(localPath: string) {
  const configPath = path.join(localPath, "truffle-box.json");
  fse.access(configPath).catch(_e => {
    throw new Error(`Truffle Box at path ${localPath} doesn't exist.`);
  });
}

async function verifyVCSURL(url: string) {
  // Next let's see if the expected repository exists. If it doesn't, ghdownload
  // will fail spectacularly in a way we can't catch, so we have to do it ourselves.
  const configURL = parseURL(
    `${vcsurl(url)
      .replace("github.com", "raw.githubusercontent.com")
      .replace(/#.*/, "")}/master/truffle-box.json`
  );

  const repoUrl = `https://${configURL.host}${configURL.path}`;
  try {
    await axios.head(repoUrl, { maxRedirects: 50 });
  } catch (error) {
    if (error.response && error.response.status === 404) {
      throw new Error(
        `Truffle Box at URL ${url} doesn't exist. If you believe this is an error, please contact Truffle support.`
      );
    } else {
      const prefix = `Error connecting to ${repoUrl}. Please check your internet connection and try again.`;
      error.message = `${prefix}\n\n${error.message || ""}`;
      throw error;
    }
  }
}

async function verifySourcePath(sourcePath: string) {
  if (sourcePath.startsWith("/")) {
    return verifyLocalPath(sourcePath);
  }
  return verifyVCSURL(sourcePath);
}

async function gitIgnoreFilter(sourcePath: string) {
  const ignoreFilter = ignore();
  try {
    const gitIgnore = await fse.readFile(
      path.join(sourcePath, ".gitignore"),
      "utf8"
    );
    ignoreFilter.add(gitIgnore.split(/\r?\n/).map(p => p.replace(/\/$/, "")));
  } catch (err) {}

  return ignoreFilter;
}

async function fetchRepository(sourcePath: string, dir: string) {
  if (sourcePath.startsWith("/")) {
    const filter = await gitIgnoreFilter(sourcePath);
    return fse.copy(sourcePath, dir, {
      filter: file =>
        sourcePath === file || !filter.ignores(path.relative(sourcePath, file))
    });
  }
  return promisify(download)(sourcePath, dir);
}

function prepareToCopyFiles(tempDir: string, { ignore }: boxConfig) {
  const needingRemoval = ignore;

  // remove box config file
  needingRemoval.push("truffle-box.json");
  needingRemoval.push("truffle-init.json");

  needingRemoval
    .map((fileName: string) => path.join(tempDir, fileName))
    .forEach((filePath: string) => fse.removeSync(filePath));
}

async function promptOverwrites(
  contentCollisions: Array<string>,
  logger = console
) {
  const overwriteContents = [];

  for (const file of contentCollisions) {
    logger.log(`${file} already exists in this directory...`);
    const overwriting: inquirer.Questions = [
      {
        type: "confirm",
        name: "overwrite",
        message: `Overwrite ${file}?`,
        default: false
      }
    ];

    const { overwrite } = await inquirer.prompt(overwriting);
    if (overwrite) {
      fse.removeSync(file);
      overwriteContents.push(file);
    }
  }

  return overwriteContents;
}

async function copyTempIntoDestination(
  tmpDir: string,
  destination: string,
  options: unboxOptions
) {
  fse.ensureDirSync(destination);
  const { force, logger } = options;
  const boxContents = fse.readdirSync(tmpDir);
  const destinationContents = fse.readdirSync(destination);

  const newContents = boxContents.filter(
    filename => !destinationContents.includes(filename)
  );

  const contentCollisions = boxContents.filter(filename =>
    destinationContents.includes(filename)
  );

  let shouldCopy;
  if (force) {
    shouldCopy = boxContents;
  } else {
    const overwriteContents = await promptOverwrites(contentCollisions, logger);
    shouldCopy = [...newContents, ...overwriteContents];
  }

  for (const file of shouldCopy) {
    fse.copySync(`${tmpDir}/${file}`, `${destination}/${file}`);
  }
}

function installBoxDependencies({ hooks }: boxConfig, destination: string) {
  const postUnpack = hooks["post-unpack"];

  if (postUnpack.length === 0) return;
  execSync(postUnpack, { cwd: destination });
}

/**
 * Recursively travel through directory.
 * @param {string} dir Directory to traverse.
 * @param {boolean} returnRelative Return result as relative paths to dir.
 * @param {string} relativeDir Parent's relative path of current recursive call.
 * @returns {string[]} Path of every file in directory.
 */
function traverseDir(dir: string, returnRelative = true, relativeDir = "") {
  const result: string[] = [];

  fse.readdirSync(dir).forEach(file => {
    const absPath = path.join(dir, file);
    const relativePath = path.join(relativeDir, file);
    const isDir = fse.statSync(absPath).isDirectory();

    if (isDir) {
      // Recurse if file is dir.
      const nested = returnRelative
        ? traverseDir(absPath, true, relativePath)
        : traverseDir(absPath, false);
      result.push(...nested);
    } else {
      // Base case: File is not dir.
      const filePath = returnRelative ? relativePath : absPath;
      result.push(filePath);
    }
  });

  return result;
}

/**
 * Recursively remove all empty dirs.
 * @param {string} dir Root dir that (nested) empty dirs should be removed from.
 */
function removeEmptyDirs(dir: string, isRoot = true) {
  const isDir = fse.statSync(dir).isDirectory();
  // Bail if not dir.
  if (!isDir) {
    return;
  }

  let files = fse.readdirSync(dir);
  if (files.length > 0) {
    files.forEach(file => {
      const fileAbs = path.join(dir, file);
      removeEmptyDirs(fileAbs, false);
    });
    // Dir may be empty after deleting nested dirs. Re-evaluate.
    files = fse.readdirSync(dir);
  }

  if (files.length === 0 && !isRoot) {
    fse.rmdirSync(dir);
  }
}

async function followBoxRecipe(
  { recipes }: boxConfig,
  destination: string,
  option: string
) {
  // Bail if no recipe defined.
  if (Object.keys(recipes).length === 0) {
    return;
  }

  // Locate recipe: User provides option / answers prompts
  let useOption = option !== undefined;
  const optionArr = option.split?.(",") || [];
  let recipeFiles = null;
  let recipeScope = recipes.specs;
  let counter = 0;
  while (!recipeFiles) {
    if (Array.isArray(recipeScope)) {
      recipeFiles = recipeScope.concat(recipes.common);
      break;
    }

    const curScopeChoices = Object.keys(recipeScope);

    const { choice } = await inquirer.prompt([
      {
        type: "list",
        message: recipes.prompts[counter].message,
        choices: curScopeChoices,
        name: "choice",
        when: hash => {
          if (useOption) {
            const curOptionChoice = optionArr[counter];
            const validChoice = curScopeChoices.includes(curOptionChoice);
            if (validChoice) {
              // Don't prompt if current option choice is valid.
              hash.choice = curOptionChoice;
              return false;
            }
            useOption = false;
          }
          return true;
        }
      }
    ]);

    recipeScope = recipeScope[choice];
    counter += 1;
  }

  // Given recipeFiles, find:
  // recipeMvs: List of all rename / move ops.
  // recipeFilesSet: Set of file paths, ignoring rename / move.
  const recipeMvs: boxConfigRecipeSpecMv[] = [];
  const recipeFilesSet = new Set();
  recipeFiles.forEach(file => {
    if (typeof file === "string") {
      recipeFilesSet.add(file);
    } else {
      recipeFilesSet.add(file.from);
      recipeMvs.push(file);
    }
  });

  // Remove files not in recipe.
  const allFiles = traverseDir(destination);
  const extraFiles = allFiles.filter(file => !recipeFilesSet.has(file));
  extraFiles.forEach(extraFile => {
    fse.removeSync(path.join(destination, extraFile));
  });

  // Move / rename files.
  recipeMvs.forEach(mv => {
    const mvFrom = path.join(destination, mv.from);
    const mvTo = path.join(destination, mv.to);
    // Create parent dir of mvTo in case it doens't exist.
    fse.ensureDirSync(path.dirname(mvTo));
    fse.renameSync(mvFrom, mvTo);
  });

  // Some dirs may be empty after removing + moving + renaming. Clean up.
  removeEmptyDirs(destination);
}

export = {
  copyTempIntoDestination,
  fetchRepository,
  installBoxDependencies,
  traverseDir,
  removeEmptyDirs,
  followBoxRecipe,
  prepareToCopyFiles,
  verifySourcePath,
  verifyVCSURL
};
