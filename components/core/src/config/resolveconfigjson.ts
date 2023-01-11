/**
 * Copyright 2023 Google LLC
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

import {
  Pluggable,
  PluggableTypeMap,
  PluggableTypeName,
} from '../integrations/pluggable';
import {PluggableFactory} from '../integrations/pluggablefactory';
import {PluggableFactorySet} from '../integrations/pluggablefactoryset';
import {
  isPluggableFactoryJsonStanza,
  PluggableFactoryJsonMapStanza,
  PluggableFactoryJsonStanza,
} from '../integrations/pluggablefactoryjson';
import {JsonValue, StringKeyOf, ValueOf} from 'type-fest';
import {StatusError} from '../util/statuserror';

/**
 * Filters the Allowed type into a map of factory keys to Pluggable factories
 * that produce objects of the given type.
 */
export type AllowedFactoriesOfType<
  Allowed extends PluggableFactorySet,
  T extends Pluggable
> = {
  [key in StringKeyOf<Allowed> as key extends string
    ? Allowed[key] extends PluggableFactory<T, unknown, unknown>
      ? key
      : never
    : never]: Allowed[key];
};

/**
 * Transforms and filters the Allowed type into a map of factory keys to JSON
 * config stanzas for the associated factory.
 */
export type AllowedFactoryJsonsOfType<
  Allowed extends PluggableFactorySet,
  T extends Pluggable
> = {
  [key in keyof AllowedFactoriesOfType<Allowed, T>]: AllowedFactoriesOfType<
    Allowed,
    T
  >[key] extends PluggableFactory<Pluggable, infer C, unknown>
    ? PluggableFactoryJsonStanza<key, C>
    : never;
};

/**
 * Returns the type of the configuration object used by the factory with the
 * given name.
 */
export type FactoryConfig<
  Allowed extends PluggableFactorySet,
  FactoryName extends StringKeyOf<Allowed>
> = AllowedFactoryNamed<Allowed, FactoryName> extends PluggableFactory<
  Pluggable,
  infer C,
  unknown
>
  ? C
  : never;

/**
 * Returns the type of object created by the given factory.
 */
export type FactoryResult<T> = T extends PluggableFactory<
  infer P,
  unknown,
  unknown
>
  ? P
  : never;

/**
 * Returns the type of the factory with the given factory name.
 */
export type AllowedFactoryNamed<
  Allowed extends PluggableFactorySet,
  FactoryName extends StringKeyOf<Allowed>
> = ValueOf<Pick<Allowed, FactoryName>>;

/**
 * The interface for resolved values produced by a given factory name. Includes
 * the output of the factory, the factory itself and the config json used to
 * produce the value.
 */
export interface ResolvedPluggableResult<
  Allowed extends PluggableFactorySet,
  FactoryName extends StringKeyOf<Allowed> = StringKeyOf<Allowed>
> {
  result: FactoryResult<Allowed[FactoryName]>;
  configJson: PluggableFactoryJsonStanza<
    FactoryName,
    FactoryConfig<Allowed, FactoryName>
  >;
  factory: Allowed[FactoryName];
}

/**
 * A type of the union of all legal JSON that could be used to configure the
 * factory with the given name.
 */
export type LegalJsonStanza<
  Allowed extends PluggableFactorySet,
  FactoryName extends StringKeyOf<Allowed> = StringKeyOf<Allowed>
> = PluggableFactoryJsonStanza<
  FactoryName,
  FactoryConfig<Allowed, FactoryName>
>;

/**
 * The type of the JSON Map that could be used to configure the factory with the
 * given name. Useful for debugging configuration typing issues.
 */
export type LegalJsonMapStanza<
  Allowed extends PluggableFactorySet,
  ModuleName extends StringKeyOf<Allowed> = StringKeyOf<Allowed>
> = PluggableFactoryJsonMapStanza<
  ModuleName,
  FactoryConfig<Allowed, ModuleName>
>;

/**
 * Extracts the factory name from the given pluggable JSON stanza.
 */
export function extractFactoryName<ModuleName extends string>(
  configJson: PluggableFactoryJsonStanza<ModuleName, unknown>
): ModuleName {
  if (typeof configJson === 'string') {
    return configJson;
  } else if (Array.isArray(configJson)) {
    return configJson[0];
  } else {
    const valAsMap = configJson as PluggableFactoryJsonMapStanza<
      ModuleName,
      unknown
    >;
    return valAsMap.moduleName;
  }
}

/**
 * Extracts the params from the given pluggable JSON stanza.
 */
export function extractParams<
  ModuleName extends StringKeyOf<Allowed>,
  Allowed extends PluggableFactorySet
>(
  configJson: PluggableFactoryJsonStanza<
    ModuleName,
    FactoryConfig<Allowed, ModuleName>
  >
): FactoryConfig<Allowed, ModuleName> {
  if (typeof configJson === 'string') {
    return undefined as FactoryConfig<Allowed, ModuleName>;
  } else if (Array.isArray(configJson)) {
    return configJson[1];
  } else {
    const valAsMap = configJson as PluggableFactoryJsonMapStanza<
      ModuleName,
      FactoryConfig<Allowed, ModuleName>
    >;
    return valAsMap.params;
  }
}

/**
 * Constructs a pluggable object from a JSON config.
 */
async function constructPluggableFromConfig<
  Allowed extends PluggableFactorySet,
  FactoryName extends StringKeyOf<Allowed> = StringKeyOf<Allowed>,
  ContextType = undefined
>(
  configJson: LegalJsonStanza<Allowed>,
  allowed: Allowed,
  expectedType: PluggableTypeName,
  context: ContextType
): Promise<ResolvedPluggableResult<Allowed, FactoryName>> {
  const factoryName = extractFactoryName(configJson);
  const params = extractParams(configJson);
  const factory = allowed[factoryName];
  if (!factory) {
    throw new StatusError('No factory found named ' + factoryName);
  }
  const val = await factory.construct(params, context, allowed);
  if (val.type !== expectedType) {
    throw new StatusError(
      'Expected ' + expectedType + ' but factory constructed ' + val.type,
      'CONFIG_ERROR_UNEXPECTED_FACTORY_OUTPUT_TYPE'
    );
  }
  val.factoryNameSource = factoryName;
  return {
    result: val as FactoryResult<Allowed[FactoryName]>,
    configJson: configJson as PluggableFactoryJsonStanza<
      FactoryName,
      FactoryConfig<Allowed, FactoryName>
    >,
    factory: factory as Allowed[FactoryName],
  };
}

/**
 * The type of a JSON config, based on an interface containing pluggable
 * objects.
 * TODO(johndayrichter): This interface should be generated from a
 * PluggableConfigDescription, rather than a plain interface.
 */
export type ConfigJson<T, Allowed extends PluggableFactorySet> = {
  [key in keyof T]: Exclude<T[key], undefined> extends Pluggable
    ? ValueOf<AllowedFactoryJsonsOfType<Allowed, Exclude<T[key], undefined>>>
    : Exclude<T[key], undefined> extends Array<infer P extends Pluggable>
    ? ValueOf<AllowedFactoryJsonsOfType<Allowed, P>>[]
    : T[key];
};

/**
 * Extracts the Pluggable type name from a PluggableConfigDescription field
 * value.
 */
export type DescFieldType<T> = T extends PluggableConfigurationFieldType
  ? T
  : T extends {type: infer N}
  ? N
  : never;

/**
 * Extracts whether a PluggableConfigDescription field is optional.
 */
export type DescFieldIsOptional<T> = T extends {isOptional: true} ? T : never;

/**
 * Extracts whether a PluggableConfigDescription field is required.
 */
export type DescFieldIsRequired<T> = T extends {isOptional: true} ? never : T;

/**
 * Extracts whether a PluggableConfigDescription field is an array.
 */
export type DescFieldIsArray<T> = T extends {isArray: true} ? T : never;

/**
 * Transforms a Pluggable type name into a type.
 */
export type PluggableConfigValueBaseType<T> =
  DescFieldType<T> extends PluggableTypeName
    ? PluggableTypeMap[DescFieldType<T>]
    : DescFieldType<T> extends 'json'
    ? JsonValue
    : DescFieldType<T> extends 'string'
    ? string
    : DescFieldType<T> extends 'number'
    ? number
    : DescFieldType<T> extends 'boolean'
    ? boolean
    : never;

/**
 * Transforms a PluggableConfigDescription field value into an actual type.
 */
export type PluggableConfigValueType<T> = T extends DescFieldIsArray<T>
  ? PluggableConfigValueBaseType<T>[]
  : PluggableConfigValueBaseType<T>;

/**
 * Transforms a PluggableConfigDescription into a configuration interface.
 */
export type PluggableConfig<T extends PluggableConfigDescription> = {
  [key in keyof T as T[key] extends DescFieldIsRequired<T[key]>
    ? key
    : never]: PluggableConfigValueType<T[key]>;
} & {
  [key in keyof T as T[key] extends DescFieldIsOptional<T[key]>
    ? key
    : never]?: PluggableConfigValueType<T[key]>;
};

/**
 * The result of resolving a configuration JSON.
 */
export interface ResolutionResult<T> {
  result: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allPluggables: Array<ResolvedPluggableResult<PluggableFactorySet>>;
  destroyAll(): Promise<void>;
}

/**
 * The possible pluggable type names in a configuration field.
 */
export type PluggableConfigurationFieldType =
  | PluggableTypeName
  | 'json'
  | 'string'
  | 'number'
  | 'boolean';

export interface PluggableConfigurationField {
  type: PluggableConfigurationFieldType;
  isOptional?: boolean;
  isArray?: boolean;
}

export interface PluggableConfigDescription {
  [key: string]: PluggableConfigurationField | PluggableConfigurationFieldType;
}

export function getExpectedTypeName(
  field: PluggableConfigurationField | PluggableConfigurationFieldType
): PluggableConfigurationFieldType {
  if (typeof field === 'string') {
    return field;
  } else {
    return field.type;
  }
}

export function isExpectedTypeOptional(
  field: PluggableConfigurationField | PluggableConfigurationFieldType
): boolean {
  if (typeof field === 'string') {
    return false;
  } else {
    return field.isOptional ?? false;
  }
}

export function isExpectedTypeArray(
  field: PluggableConfigurationField | PluggableConfigurationFieldType
): boolean {
  if (typeof field === 'string') {
    return false;
  } else {
    return field.isArray ?? false;
  }
}

export function isExpectedFieldTypePluggable(
  type: PluggableConfigurationFieldType
): type is PluggableTypeName {
  return (
    type !== 'json' &&
    type !== 'boolean' &&
    type !== 'number' &&
    type !== 'string'
  );
}

/**
 * Resolves a JSON configuration with pluggable configuration stanzas into an
 * object where all the pluggable config stanzas are resolved into constructed
 * Pluggable objects.
 * TODO(johndayrichter): This module is an absolute mess. There are two very
 * different mechanisms here for specifying the format of a configuration file,
 * and the entire thing is very complex and unweildy. This needs to be
 * re-written from the ground up.
 */
export async function resolveConfigJson<
  ResultType,
  Allowed extends PluggableFactorySet,
  X = undefined
>(
  config: ConfigJson<ResultType, Allowed>,
  configDesc: PluggableConfigDescription,
  allowed: Allowed,
  context?: X
): Promise<ResolutionResult<ResultType>> {
  const resultObj: Record<string, unknown> = {};
  const allPluggables: Array<ResolvedPluggableResult<Allowed>> = [];
  for (const key in config) {
    const configDescFieldValue = configDesc[key];
    if (!configDescFieldValue) {
      throw new StatusError(
        'Unexpected config key ' + key,
        'CONFIG_ERROR_UNKNOWN_KEY'
      );
    }
    const expectedType = getExpectedTypeName(configDescFieldValue);
    const configVal = config[key];
    let resultVal;
    if (isExpectedFieldTypePluggable(expectedType)) {
      if (isExpectedTypeArray(configDescFieldValue)) {
        if (!Array.isArray(configVal)) {
          throw new StatusError(
            'Expected array for config key ' + key,
            'CONFIG_ERROR_EXPECTED_ARRAY'
          );
        }
        const newArray = [];
        for (const subVal of configVal) {
          const subResultVal = await constructPluggableFromConfig(
            subVal as LegalJsonStanza<Allowed>,
            allowed,
            expectedType,
            context
          );
          allPluggables.push(subResultVal);
          newArray.push(subResultVal.result);
        }
        resultObj[key] = newArray;
      } else {
        resultVal = await constructPluggableFromConfig(
          configVal as LegalJsonStanza<Allowed>,
          allowed,
          expectedType,
          context
        );
        allPluggables.push(resultVal);
        resultObj[key] = resultVal.result;
      }
    } else {
      if (expectedType !== 'json' && typeof configVal !== expectedType) {
        throw new StatusError(
          'Wrong type for config field ' + key,
          'CONFIG_ERROR_BAD_VALUE_TYPE'
        );
      }
      resultObj[key] = configVal;
    }
  }
  return {
    result: resultObj as ResultType,
    allPluggables: allPluggables,
    async destroyAll(): Promise<void> {
      await Promise.all(
        allPluggables.map(p => p.result.destroy && p.result.destroy())
      );
    },
  };
}
