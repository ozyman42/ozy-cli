import { Effect, Option, Schema, SchemaTransformation, pipe, SchemaIssue } from "effect";

const PackageRef = pipe(
  Schema.NonEmptyString.check(Schema.isPattern(/^(?:@[^/]+\/[^/]+|(?!@)[^/]+)$/)),
  Schema.decodeTo(
    Schema.Struct({
      scope: Schema.Option(Schema.String),
      packageName: Schema.String,
      raw: Schema.String,
    }),
    SchemaTransformation.transform({
      decode: (raw) => {
        const slash = raw.indexOf("/")
        return {
          // We remove the leading "@" from the scope
          scope: slash === -1
            ? Option.none()
            : Option.some(raw.slice(1, slash)),
          packageName: raw.slice(slash + 1),
          raw,
        }
      },
      encode: ({ raw }) => raw,
    }),
  )
);
export type PackageRef = Schema.Schema.Type<typeof PackageRef>;

const Repository = Schema.Struct({
  type: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  directory: Schema.OptionFromOptionalNullOr(Schema.NonEmptyString),
});

export const PackageJsonSchema = Schema.Struct({
  $schema: Schema.String,
  license: Schema.String,
  name: PackageRef,
  version: Schema.OptionFromOptionalNullOr(Schema.NonEmptyString),
  repository: Schema.OptionFromOptionalNullOr(Repository),
  files: Schema.OptionFromOptionalNullOr(Schema.Array(Schema.NonEmptyString)),
});
export type PackageJson = Schema.Schema.Type<typeof PackageJsonSchema> & Record<string, unknown>;

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export function parsePackageName(name: string) {
  return pipe(
    Schema.decodeUnknownEffect(PackageRef)(name),
    Effect.catchTag("SchemaError", e => Effect.fail(formatSchemaError(e.issue)))
  );
}

export function validatePackageJson(json: string) {
  try {
    const parsed = JSON.parse(json);
    return pipe(
      Schema.decodeUnknownEffect(PackageJsonSchema, {onExcessProperty: "ignore"})(parsed),
      Effect.catchTag("SchemaError", e => Effect.fail(formatSchemaError(e.issue)))
    );
  } catch (e) {
    return Effect.fail(`Invalid JSON: ${(e as Error).message}`);
  }
}

export function encodePackageJson(packageJson: PackageJson) {
  return pipe(
    Schema.encodeEffect(PackageJsonSchema, { onExcessProperty: "ignore" })(packageJson),
    Effect.catchTag("SchemaError", e => Effect.fail(formatSchemaError(e.issue))),
    Effect.map(encoded => JSON.stringify(encoded, null, 2))
  );
}
