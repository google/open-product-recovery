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
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  JWTVerifyOptions,
  JWTVerifyResult,
} from 'jose';
import {
  DecodedReshareChain,
  DecodedReshareChainLink,
  ReshareChain,
} from 'opr-models';
import {OrgConfigProvider} from '../config/orgconfigprovider';
import {StatusError} from '../util/statuserror';
import {jwtPayloadToChainLink} from './decodechain';
import {extractSignature} from './tokenparts';
import {Verifier, VerifyChainOptions} from './verifier';

export class StandardVerifier implements Verifier {
  readonly type = 'verifier';

  private configProvider: OrgConfigProvider;

  constructor(configProvider: OrgConfigProvider) {
    this.configProvider = configProvider;
  }

  async verify(
    token: string,
    options?: JWTVerifyOptions
  ): Promise<JWTVerifyResult> {
    const decodedPayload = decodeJwt(token);
    const issuer = decodedPayload.iss;
    if (!issuer) {
      throw new StatusError(
        'No issuer specified in token: ' + token,
        'AUTH_ERROR_MISSING_TOKEN_ISSUER',
        500
      );
    }
    const jwks = await this.configProvider.getJwks(issuer);
    const keyset = createLocalJWKSet(jwks);
    try {
      return await jwtVerify(token, keyset, options);
    } catch (e) {
      if (e instanceof Error && 'code' in e) {
        if (typeof e['code'] === 'string') {
          const code = e['code'] as string;
          switch (code) {
            case 'ERR_JWT_EXPIRED':
              throw new StatusError(
                'Authentication error',
                'AUTH_ERROR_TOKEN_EXPIRED',
                401,
                e
              );
          }
        }
      }
      throw new StatusError('Authentication error', 'AUTH_ERROR', 401, e);
    }
  }

  private async decodeAndVerifyChainToken(
    token: string
  ): Promise<DecodedReshareChainLink> {
    const tokenPayload = (await this.verify(token)).payload;
    const signature = extractSignature(token);
    return jwtPayloadToChainLink(tokenPayload, signature);
  }

  async verifyChain(
    chain: Readonly<ReshareChain>,
    options: VerifyChainOptions
  ): Promise<DecodedReshareChain> {
    if (chain.length < 1) {
      throw new StatusError(
        'Token chain must contain at least one element',
        'CHAIN_TOKEN_INVALID',
        403
      );
    }
    // Indepedently verify that all the tokens were properly signed
    // by their issuers.
    const decodedTokens = await Promise.all(
      chain.map(x => this.decodeAndVerifyChainToken(x))
    );

    // Checks that the decoded chain has the proper invariants.
    verifyDecodedChain(decodedTokens, options);

    return decodedTokens;
  }
}

export function verifyDecodedChain(
  chain: DecodedReshareChain,
  options: VerifyChainOptions
): void {
  if (chain.length < 1) {
    throw new StatusError(
      'Token chain must contain at least one element',
      'CHAIN_TOKEN_INVALID',
      403
    );
  }

  // Check that the initial issuer is the expected initial issuer. This
  // prevents a valid token chain from being stolen and used on a different
  // server for an item with the same identifier.
  if (
    options.initialIssuer &&
    chain[0].sharingOrgUrl !== options.initialIssuer
  ) {
    throw new StatusError(
      'Token chain specifies the wrong initial issuer',
      'CHAIN_TOKEN_BAD_INITIAL_ISSUER',
      403
    );
  }
  // Check that the initial entitlement is the expected value. This prevents a
  // valid token chain from being used on an offer besides the intented offer.
  if (
    options.initialEntitlements &&
    chain[0].entitlements !== options.initialEntitlements
  ) {
    throw new StatusError(
      'Token chain specifies the wrong initial entitlements',
      'CHAIN_TOKEN_BAD_INITIAL_ENTITLEMENTS',
      403
    );
  }
  // Check that the final subject matches the expected value. This prevents a
  // valid token chain from being used by some other party besides the one
  // specified.
  const lastDecodedLink = chain[chain.length - 1];
  if (
    options.finalSubject &&
    lastDecodedLink.recipientOrgUrl !== options.finalSubject
  ) {
    throw new StatusError(
      'Token chain specifies the wrong final subject',
      'CHAIN_TOKEN_BAD_FINAL_SUBJECT',
      403
    );
  }
  // Check that each stage in the chain references the entitlements
  // and subject of the previous stage. This prevents chain reordering or
  // substitutions of elements from one valid chain into another.
  for (let i = 1; i < chain.length; i++) {
    // The issuer at each stage must match the subject at the prior stage,
    // because only the subject of a stage could sign the next link in the
    // chain.
    if (chain[i].sharingOrgUrl !== chain[i - 1].recipientOrgUrl) {
      throw new StatusError(
        'Token chain issuer does not match previous subject at position ' + i,
        'CHAIN_TOKEN_ISS_SUB_MISMATCH',
        403
      );
    }
    // The entitlements at each stage must match the signature of the prior
    // stage, as per the spec.
    if (chain[i].entitlements !== chain[i - 1].signature) {
      throw new StatusError(
        'Token chain entitlements claim does not match ' +
          'previous signature at position ' +
          i,
        'CHAIN_TOKEN_BAD_ENTITLEMENT',
        403
      );
    }
  }

  // Check that all elements of the chain before the last have the
  // 'reshare' scope. This prevents resharing without permission.
  for (let i = 0; i < chain.length - 1; i++) {
    if (chain[i].scopes.indexOf('RESHARE') < 0) {
      throw new StatusError(
        'Reshare scope missing at position ' + i,
        'CHAIN_TOKEN_ILLEGAL_RESHARE',
        403
      );
    }
  }

  // Check that the last decoded token has the expected scope. This optional
  // step is used to check whether the token is allowed to be used for its
  // intended purpose.
  if (options.finalScope) {
    if (lastDecodedLink.scopes.indexOf(options.finalScope) < 0) {
      throw new StatusError(
        'Expected scope missing at final position',
        'CHAIN_TOKEN_BAD_FINAL_SCOPE',
        403
      );
    }
  }
}
