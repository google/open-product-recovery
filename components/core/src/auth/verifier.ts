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

import {JWTVerifyOptions, JWTVerifyResult} from 'jose';
import {ChainScope} from './chainscope';
import {DecodedReshareChain, ReshareChain} from 'opr-models';
import {Pluggable} from '../integrations/pluggable';

export interface VerifyChainOptions {
  initialIssuer?: string;
  initialEntitlements?: string;
  finalSubject?: string;
  finalScope?: ChainScope;
}

export interface Verifier extends Pluggable {
  readonly type: 'verifier';

  verify(token: string, options?: JWTVerifyOptions): Promise<JWTVerifyResult>;
  verifyChain(
    chain: Readonly<ReshareChain>,
    options: VerifyChainOptions
  ): Promise<DecodedReshareChain>;
}
