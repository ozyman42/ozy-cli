import ejs from "ejs";
import { Effect, FileSystem } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { dirname, join, relative } from "node:path";
import { cliModules } from "@/modules/cli";
import type { ITemplates, RenderTemplateResult } from "./interface";

const EJS_SUFFIX = ".ejs";

interface TemplateFile {
  readonly relativePath: string;
  readonly sourcePath: string;
}

export class TemplatesImpl extends implementing(cliModules.Templates).uses(FileSystem.FileSystem) implements ITemplates {
  *renderTemplate(sourceDir: string, targetDir: string, data: Record<string, unknown> = {}): EffectGen<RenderTemplateResult, string> {
    const fileSystem = this.getDependency(FileSystem.FileSystem);
    return yield* renderTemplateDirectory(fileSystem, sourceDir, targetDir, data);
  }
}

function* renderTemplateDirectory(
  fileSystem: FileSystem.FileSystem,
  sourceDir: string,
  targetDir: string,
  data: Record<string, unknown>
): EffectGen<RenderTemplateResult, string> {
  const files = yield* collectTemplateFiles(fileSystem, sourceDir, sourceDir);
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const file of files) {
    const relativeSourcePath = file.relativePath;
    const relativeTargetPath = relativeSourcePath.endsWith(EJS_SUFFIX)
      ? relativeSourcePath.slice(0, -EJS_SUFFIX.length)
      : relativeSourcePath;
    const targetPath = join(targetDir, relativeTargetPath);

    if (yield* pathExists(fileSystem, targetPath)) {
      skippedFiles.push(relativeTargetPath);
      continue;
    }

    yield* mapFileSystemError(fileSystem.makeDirectory(dirname(targetPath), { recursive: true }), `failed to create ${dirname(targetPath)}`);
    if (relativeSourcePath.endsWith(EJS_SUFFIX)) {
      const template = yield* mapFileSystemError(fileSystem.readFileString(file.sourcePath), `failed to read ${file.sourcePath}`);
      let rendered: string;
      try {
        rendered = ejs.render(template, data, { filename: file.sourcePath });
      } catch (error) {
        return yield* Effect.fail(error instanceof Error ? error.message : String(error));
      }
      yield* mapFileSystemError(fileSystem.writeFileString(targetPath, rendered), `failed to write ${targetPath}`);
    } else {
      yield* mapFileSystemError(fileSystem.copyFile(file.sourcePath, targetPath), `failed to copy ${file.sourcePath} to ${targetPath}`);
    }
    writtenFiles.push(relativeTargetPath);
  }

  return { writtenFiles, skippedFiles };
}

function* collectTemplateFiles(fileSystem: FileSystem.FileSystem, sourceDir: string, currentDir: string): EffectGen<TemplateFile[], string> {
  const entries = yield* mapFileSystemError(fileSystem.readDirectory(currentDir), `failed to read ${currentDir}`);
  const files: TemplateFile[] = [];

  for (const entry of entries.sort()) {
    const childPath = join(currentDir, entry);
    const stat = yield* mapFileSystemError(fileSystem.stat(childPath), `failed to stat ${childPath}`);
    if (stat.type === "Directory") {
      files.push(...yield* collectTemplateFiles(fileSystem, sourceDir, childPath));
    } else if (stat.type === "File") {
      files.push({
        relativePath: toPosixPath(relative(sourceDir, childPath)),
        sourcePath: childPath,
      });
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function* pathExists(fileSystem: FileSystem.FileSystem, path: string): EffectGen<boolean, string> {
  return yield* mapFileSystemError(fileSystem.exists(path), `failed to check ${path}`);
}

function* mapFileSystemError<A>(effect: Effect.Effect<A, unknown>, context: string): EffectGen<A, string> {
  return yield* Effect.mapError(effect, (error) => `${context}: ${String(error)}`);
}
