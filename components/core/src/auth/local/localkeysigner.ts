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

import {Clock} from '../../util/clock';
import {DefaultClock} from '../../util/defaultclock';
import {StatusError} from '../../util/statuserror';
import {importJWK, JWK, JWTPayload, SignJWT} from 'jose';
import {Signer, IssueTokenOptions, SignChainOptions} from '../signer';
import {ReshareChain} from 'opr-models';
import {TenantNodeIntegrationContext} from '../../config/hostintegrationcontext';
import {PluggableFactory} from '../../integrations/pluggablefactory';
import {JsonMap} from '../../util/jsonvalue';

const DEFAULT_TOKEN_MAX_AGE_MILLIS = 10 * 60 * 1000; // 10 minutes

export class LocalKeySigner implements Signer {
  readonly type = 'signer';

  protected issuer: string;
  private privateKeyProvider: () => Promise<JWK>;
  private clock: Clock;

  constructor(
    issuer: string,
    privateKeyProvider: (() => Promise<JWK>) | JWK,
    clock: Clock = new DefaultClock()
  ) {
    this.issuer = issuer;
    this.clock = clock;
    if (typeof privateKeyProvider === 'function') {
      this.privateKeyProvider = privateKeyProvider;
    } else {
      this.privateKeyProvider = async () => {
        return privateKeyProvider;
      };
    }
  }

  async signChain(
    chain: ReshareChain,
    sub: string,
    options?: SignChainOptions
  ): Promise<ReshareChain> {
    let entitlement = options?.initialEntitlement;
    if (chain.length > 0) {
      const lastToken = chain[chain.length - 1];
      const tokenParts = lastToken.split('.');
      const lastSig = tokenParts[tokenParts.length - 1];
      entitlement = lastSig;
    }
    if (!entitlement) {
      throw new Error('Cannot sign a chain without an entitlement');
    }
    const jwk = await this.getPrivateKey();
    const key = await importJWK(jwk);
    const payload = {
      entitlements: entitlement,
    } as Record<string, unknown>;
    if (options?.scopes && options?.scopes.length) {
      payload['scope'] = options.scopes.join(' ');
    }
    const signJwt = this.createSignJwt(payload)
      .setProtectedHeader({alg: jwk.alg!})
      .setIssuer(this.issuer)
      .setSubject(sub);
    const token = await signJwt.sign(key);
    return [...chain, token];
  }

  private async getPrivateKey(): Promise<JWK> {
    const jwk = await this.privateKeyProvider();
    if (!jwk.alg) {
      throw new StatusError('JWKs in OPR must specify an alg');
    }
    return jwk;
  }

  protected createSignJwt(payload: JWTPayload): SignJWT {
    return new SignJWT(payload);
  }

  async issueToken(aud: string, options?: IssueTokenOptions): Promise<string> {
    const jwk = await this.getPrivateKey();
    const key = await importJWK(jwk);
    const payload = {} as Record<string, unknown>;
    if (options?.scopes && options?.scopes.length) {
      payload['scope'] = options.scopes.join(' ');
    }
    const maxAgeMillis = options?.maxAgeMillis || DEFAULT_TOKEN_MAX_AGE_MILLIS;
    const signJwt = this.createSignJwt(payload)
      .setProtectedHeader({alg: jwk.alg!})
      .setIssuedAt(Math.round(this.clock.now() / 1000))
      .setIssuer(this.issuer)
      .setAudience(aud)
      .setExpirationTime(Math.round((this.clock.now() + maxAgeMillis) / 1000));
    if (options?.sub) {
      signJwt.setSubject(options.sub);
    }
    return await signJwt.sign(key);
  }
}

export interface LocalKeySignerIntegrationOptions {
  privateKey: JWK;
}

export const LocalKeySignerIntegration = {
  async construct(
    json: LocalKeySignerIntegrationOptions,
    context: TenantNodeIntegrationContext
  ) {
    const issuer = context.hostOrgUrl;
    if (!issuer) {
      throw new StatusError(
        'Unexpected condition, host org url not set in host integration',
        'NO_HOST_ORG_URL'
      );
    }
    if (!json.privateKey) {
      throw new StatusError(
        'No private key specified',
        'LOCAL_KEY_SIGNER_NO_PRIVATE_KEY'
      );
    }
    return new LocalKeySigner(context.hostOrgUrl, json.privateKey);
  },
};
