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

import {Pluggable} from './pluggable';
import {PluggableFactory} from './pluggablefactory';

export type PluggableFactorySet<
  T extends PluggableFactory<Pluggable, unknown, unknown> = PluggableFactory<
    Pluggable,
    unknown,
    unknown
  >
> = {
  [key: string]: T;
};

export type NamespacedFactorySet<
  T extends PluggableFactorySet<PluggableFactory<Pluggable, unknown, unknown>>,
  namespace extends string
> = {
  [Property in keyof T as `${namespace & string}${Capitalize<
    string & Property
  >}`]: T[Property];
};

/**
 * Copies a factory set to a new factory set where all the keys are capitalized
 * and prefixed with the given namespace. For example, given the set:
 * const integrations = {
 *   StaticMultiTenant: {...},
 *   localJwks: {...}
 * };
 *
 * A call to namespaceSet(integrations, 'core') would result in the object:
 *
 * {
 *   coreStaticMultiTenant: {...},
 *   coreLocalJwks: {...}
 * }
 */
export function namespaceSet<T extends PluggableFactorySet, N extends string>(
  set: T,
  namespace: N
): NamespacedFactorySet<T, N> {
  const r: Record<string, PluggableFactory<Pluggable, unknown, unknown>> = {};
  for (const key in set) {
    r[namespace + key.substring(0, 1).toUpperCase() + key.substring(1)] =
      set[key];
  }
  return r as NamespacedFactorySet<T, N>;
}
