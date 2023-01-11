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

import {ReshareChain} from 'opr-models';
import {Pluggable} from '../integrations/pluggable';
import {ChainScope} from './chainscope';

export interface IssueTokenOptions {
  /** Optional subject string for the token. */
  sub?: string;
  /** Optional list of scopes for the token. */
  scopes?: Array<string>;
  /** The maximum age of this token in milliseconds. */
  maxAgeMillis?: number;
}

export interface SignChainOptions {
  initialEntitlement?: string;
  scopes?: Array<ChainScope>;
}

export interface Signer extends Pluggable {
  readonly type: 'signer';

  issueToken(aud: string, options?: IssueTokenOptions): Promise<string>;
  signChain(
    chain: Readonly<ReshareChain>,
    sub: string,
    options?: SignChainOptions
  ): Promise<ReshareChain>;
}
