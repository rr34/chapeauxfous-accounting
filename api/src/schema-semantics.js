import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSemanticForm,
  compileSchemaProjection,
} from "schema-semantic-compiler";

const here = path.dirname(fileURLToPath(import.meta.url));
export const semanticFormFilename = path.resolve(here, "../../db/schema-semantics.json");

export class AccountingSchemaSemantics {
  constructor(filename = semanticFormFilename) {
    this.filename = filename;
    let form;
    try {
      form = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      throw new Error(`Cannot load accounting schema semantic form ${filename}: ${error.message}`);
    }
    this.form = assertSemanticForm(form);
  }

  compile(operation) {
    return compileSchemaProjection({ form: this.form, operation });
  }

  route(requestText, routing = { limit: 4, minimumScore: 3 }) {
    return compileSchemaProjection({ form: this.form, requestText, routing });
  }
}

export function withSchemaProjection(schemaSemantics, result, operation) {
  return {
    ...result,
    schemaProjection: schemaSemantics.compile(operation),
  };
}
