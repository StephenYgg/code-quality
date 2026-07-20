import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import { ProviderError } from "./provider.js";

export interface ProviderResponseValidator {
  assertValid(content: unknown): void;
}

export interface PreparedProviderSchema {
  readonly schema: unknown;
  readonly json: string;
  readonly validator: ProviderResponseValidator;
}

const MAX_PROVIDER_SCHEMA_BYTES = 64 * 1024;
const MAX_PROVIDER_SCHEMA_DEPTH = 64;
const MAX_PROVIDER_SCHEMA_NODES = 4_096;

function assertSchemaStructure(schema: unknown): void {
  const active = new WeakSet();
  const stack: {
    readonly value: unknown;
    readonly depth: number;
    readonly leaving?: boolean;
  }[] = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.leaving === true) {
      active.delete(frame.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_PROVIDER_SCHEMA_NODES) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        "Provider output schema exceeded its node limit",
      );
    }
    if (frame.depth > MAX_PROVIDER_SCHEMA_DEPTH) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        "Provider output schema exceeded its depth limit",
      );
    }
    if (frame.value === null || typeof frame.value !== "object") {
      continue;
    }
    if (active.has(frame.value)) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        "Provider output schema contains a cycle",
      );
    }
    active.add(frame.value);
    stack.push({ ...frame, leaving: true });
    let children: readonly unknown[];
    try {
      children = Array.isArray(frame.value)
        ? frame.value
        : Object.values(frame.value as Record<string, unknown>);
    } catch {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        "Provider output schema could not be inspected",
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: frame.depth + 1 });
    }
  }
}

function compileValidator(schema: unknown): ProviderResponseValidator {
  let validate: ValidateFunction;
  try {
    // Per-review compilation avoids an unbounded process-global schema cache.
    validate = new Ajv2020({ allErrors: false, strict: false }).compile(
      schema as AnySchema,
    );
  } catch {
    throw new ProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Provider output schema could not be compiled",
    );
  }
  return {
    assertValid(content: unknown): void {
      if (validate(content)) return;
      const failure = validate.errors?.[0];
      const location = failure?.instancePath || "/";
      const keyword = failure?.keyword ?? "schema";
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        `Provider response failed output schema validation at ${location} (${keyword})`,
      );
    },
  };
}

export function prepareProviderResponseSchema(
  schema: unknown,
  maxRequestBytes: number,
): PreparedProviderSchema {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new ProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Provider request byte limit must be a positive integer",
    );
  }
  assertSchemaStructure(schema);
  let json: string | undefined;
  try {
    json = JSON.stringify(schema);
  } catch {
    // Emit the stable contract error below.
  }
  if (json === undefined) {
    throw new ProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Provider output schema is not serializable JSON",
    );
  }
  const maxSchemaBytes = Math.min(maxRequestBytes, MAX_PROVIDER_SCHEMA_BYTES);
  if (Buffer.byteLength(json, "utf8") > maxSchemaBytes) {
    throw new ProviderError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider output schema exceeded its hard limit",
    );
  }
  let prepared: unknown;
  try {
    prepared = JSON.parse(json) as unknown;
  } catch {
    throw new ProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Provider output schema is not serializable JSON",
    );
  }
  return Object.freeze({
    schema: prepared,
    json,
    validator: compileValidator(prepared),
  });
}

export function compileProviderResponseValidator(
  schema: unknown,
): ProviderResponseValidator {
  return prepareProviderResponseSchema(schema, MAX_PROVIDER_SCHEMA_BYTES)
    .validator;
}
