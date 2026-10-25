import type { EffectGen } from "effective-modules";

export interface RenderTemplateResult {
  readonly writtenFiles: readonly string[];
  readonly skippedFiles: readonly string[];
}

export interface ITemplates {
  /** Renders a template directory into a target directory, preserving relative paths and skipping existing files. */
  renderTemplate(sourceDir: string, targetDir: string, data?: Record<string, unknown>): EffectGen<RenderTemplateResult, string>;
}
