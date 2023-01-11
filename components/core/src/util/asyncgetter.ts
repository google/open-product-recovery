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

import {Clock} from './clock';
import {DefaultClock} from './defaultclock';

/** An unordered set of organization urls. */
export interface AsyncGetter<T> {
  get(): Promise<T>;
}

export interface CachedAsyncGetterOptions<T> {
  clock?: Clock;
  delegate: AsyncGetter<T>;
  maxAgeMillis?: number;
}

export class CachedAsyncGetter<T> implements AsyncGetter<T> {
  private clock: Clock;
  private cache?: T;
  private delegate: AsyncGetter<T>;
  private lastCacheFetchTimestampUTC?: number;
  private maxAgeMillis: number;

  constructor(options: CachedAsyncGetterOptions<T>) {
    this.clock = options.clock || new DefaultClock();
    this.delegate = options.delegate;
    this.maxAgeMillis = options.maxAgeMillis ?? 60 * 1000 /* one minute */;
  }

  getCacheAgeMillis(): number {
    return this.lastCacheFetchTimestampUTC === undefined
      ? Number.POSITIVE_INFINITY
      : this.clock.now() - this.lastCacheFetchTimestampUTC;
  }

  async get(): Promise<T> {
    if (!this.cache || this.getCacheAgeMillis() > this.maxAgeMillis) {
      this.cache = await this.delegate.get();
    }
    return this.cache;
  }
}

export class StaticAsyncGetter<T> implements AsyncGetter<T> {
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  set(value: T) {
    this.value = value;
  }

  async get(): Promise<T> {
    return this.value;
  }

  static build<T>(value: T): AsyncGetter<T> {
    return new StaticAsyncGetter(value);
  }
}

export function asAsyncGetter<T>(value: T | AsyncGetter<T>): AsyncGetter<T> {
  if ((value as AsyncGetter<T>).get) {
    return value as AsyncGetter<T>;
  }
  return StaticAsyncGetter.build(value as T);
}
