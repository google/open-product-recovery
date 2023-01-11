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

export type JsonValue = string | number | boolean | JsonMap | JsonArray | null;

export interface JsonMap {
  // Undefined values are not strictly valid for JSON, but JSON.stringify strips
  // undefined, so this allows us to treat interfaces with optional values as
  // JSON maps
  [x: string]: JsonValue | undefined;
}

export type JsonArray = Array<JsonValue>;
