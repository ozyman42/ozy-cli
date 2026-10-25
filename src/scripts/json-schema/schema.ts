import { JsonSchema, Schema } from "effect";
import { PackageJsonSchema } from "jive-abstract-library";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const draft07Schema = JsonSchema.toDocumentDraft07(
  Schema.toJsonSchemaDocument(PackageJsonSchema)
);

const jsonSchema = allowRootAdditionalProperties(
  withDraft07MetaSchema(
    normalizeHomogeneousArraySchemas({
      ...draft07Schema.schema,
      ...(Object.keys(draft07Schema.definitions).length === 0
        ? {}
        : { definitions: draft07Schema.definitions }),
    })
  )
);

writeFileSync(resolve(__dirname, "json-schema.json"), JSON.stringify(jsonSchema, null, 2));

function withDraft07MetaSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...schema
  };
}

function allowRootAdditionalProperties(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  return {
    ...schema,
    additionalProperties: true
  };
}

function normalizeHomogeneousArraySchemas(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const normalized = normalizeJsonSchemaNode(schema);
  if (!isJsonSchemaObject(normalized)) {
    throw new Error("expected generated JSON Schema root to be an object");
  }
  return normalized;
}

function normalizeJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonSchemaNode);
  }
  if (!isJsonSchemaObject(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeJsonSchemaNode(child);
  }

  const type = normalized["type"];
  const items = normalized["items"];
  const additionalItems = normalized["additionalItems"];
  if (
    type === "array"
    && Array.isArray(items)
    && items.length === 1
    && additionalItems !== undefined
    && JSON.stringify(items[0]) === JSON.stringify(additionalItems)
  ) {
    normalized["items"] = items[0];
    delete normalized["additionalItems"];
  }

  return normalized;
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
