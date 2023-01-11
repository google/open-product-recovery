/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import jsonSchema, {ValidationError} from 'jsonschema';
import type {ValidatorResult as JsonSchemaValidatorResult} from 'jsonschema';
import * as schema from './types-generated/schemas';
import {Offer, SchemaNameToType} from './types-generated/types';

export class ValidatorResult {
  readonly valid: boolean;
  readonly validatorResult: JsonSchemaValidatorResult;
  readonly additionalErrors: ReadonlyArray<string>;
  constructor(
    validatorResult: JsonSchemaValidatorResult,
    additionalErrors: Array<string> = []
  ) {
    this.valid = validatorResult.valid && additionalErrors.length === 0;
    this.validatorResult = validatorResult;
    this.additionalErrors = additionalErrors;
  }

  getErrorMessage(): string | null {
    if (this.valid) {
      return null;
    }
    const jsonErrors = this.validatorResult.errors
      .filter(e => {
        return (
          this.validatorResult.errors.length === 1 ||
          e.schema !== 'error.result.schema.json'
        );
      })
      .map((e, index) => {
        return (index === 0 ? '' : '  ') + this.errorToErrorMessage(e);
      });
    return jsonErrors.concat(this.additionalErrors).join('\n');
  }

  /** Converts an error to a string error message. */
  errorToErrorMessage(error: ValidationError): string {
    const schemaName =
      typeof error.schema === 'string' ? error.schema + ': ' : '';
    const path = error.path.length ? '/' + error.path.join('/') + ': ' : '';
    return schemaName + path + error.stack;
  }

  toString(): string {
    const errorMessage = this.getErrorMessage();
    return errorMessage || 'valid';
  }
}
/**
 * Validates JSON against the OPR API value schemas.
 */
class OprValidator {
  private validator: jsonSchema.Validator;
  private schemaByType: Record<string, Record<string, unknown>>;
  private schemaById: Record<string, Record<string, unknown>>;
  private validatorById: Record<string, (x: unknown) => Array<string>>;

  /** @constructor */
  constructor() {
    this.validator = new jsonSchema.Validator();
    this.schemaById = {};
    this.schemaByType = {};
    this.validatorById = {};
    for (const schemaJson of Object.values(schema)) {
      this.addSchema(schemaJson as Record<string, unknown>);
    }
    this.registerValidatorFunction('offer.schema.json', (x: unknown) => {
      return this.validateOffer(x as Offer);
    });
  }

  registerValidatorFunction(
    schemaId: string,
    fn: (x: unknown) => Array<string>
  ) {
    this.validatorById[schemaId] = fn;
  }

  private validateOffer(x: Offer): Array<string> {
    const offer = x as Offer;
    const errors = [] as Array<string>;
    if (!offer.offeredBy) {
      errors.push('offeredBy field is required by the OPR protocol spec');
    }
    return errors;
  }

  /**
   * Returns the schema with the given id.
   */
  getSchemaById(id: string): Record<string, unknown> | undefined {
    return this.schemaById[id];
  }

  /**
   * Returns the schema with the given title.
   */
  getSchemaByTitle(title: string): Record<string, unknown> | undefined {
    return this.schemaByType[title];
  }

  /**
   * Returns all registered schema ids.
   */
  getSchemaIds(): Array<string> {
    const ids = [];
    for (const key in this.schemaById) {
      if (Object.prototype.hasOwnProperty.call(this.schemaById, key)) {
        ids.push(key);
      }
    }
    ids.sort();
    return ids;
  }

  /**
   * Registers a schema with the validator.
   */
  addSchema(schema: Record<string, unknown>): void {
    this.schemaById[schema.$id as string] = schema;
    this.schemaByType[schema.title as string] = schema;
    this.validator.addSchema(schema);
  }

  /**
   * Checks the given JSON value against the schema given by schemaNameOrTypeId.
   * If the check fails, a ValidatorError is thrown containing the details of
   * the failed validation. If the check passes, the json value is cast to the
   * appropriate TypeScriptType.
   *
   * schemaNameOrTypeId must be the $id or title of a schema that was compiled
   * into generated_types/types.ts.
   */
  validateAndCast<T extends keyof SchemaNameToType>(
    json: unknown,
    schemaTypeNameOrId: T
  ): asserts json is SchemaNameToType[T] {
    const schema =
      this.getSchemaById(schemaTypeNameOrId) ??
      this.getSchemaByTitle(schemaTypeNameOrId);
    if (!schema) {
      throw new Error(
        'Unexpected condition: could not find ' +
          `schema for id ${schemaTypeNameOrId}`
      );
    }
    const result = this.validate(json, schema);
    if (!result.valid) {
      throw new ValidatorError(result);
    }
  }

  /**
   * Validates the given json object against the specified schema, returning
   * the full results from the JSON validator.
   */
  validate(
    json: unknown,
    schemaOrId: Record<string, unknown> | string
  ): ValidatorResult {
    let schema = schemaOrId;
    if (typeof schema === 'string') {
      schema = this.schemaById[schema];
      if (!schema) {
        throw new Error(`Schema ${schemaOrId} not found`);
      }
    }
    const schemaResult = this.validator.validate(json, schema, {
      nestedErrors: true,
    });
    const additionalErrors = this.findAdditionalErrors(json, schemaOrId);
    return new ValidatorResult(schemaResult, additionalErrors);
  }

  private findAdditionalErrors(
    json: unknown,
    schemaOrId: Record<string, unknown> | string
  ): Array<string> {
    const schemaId =
      typeof schemaOrId === 'string'
        ? schemaOrId
        : (schemaOrId['$id'] as string);
    const validatorFn = this.validatorById[schemaId];
    return validatorFn ? validatorFn(json) : [];
  }
}

export class ValidatorError extends Error {
  readonly validatorResult;

  constructor(validatorResult: ValidatorResult) {
    super(validatorResult.getErrorMessage() || 'Validation error');
    this.validatorResult = validatorResult;
  }
}

const Validator: OprValidator = new OprValidator();
export {Validator};
