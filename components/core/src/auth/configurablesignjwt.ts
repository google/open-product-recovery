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

import {JWTHeaderParameters, SignJWT} from 'jose';
import {TextEncoder} from 'util';
import {base64url} from 'jose';

export class ConfigurableSignJWT extends SignJWT {
  private _pHeader?: JWTHeaderParameters;

  /**
   * Sets the JWS Protected Header on the SignJWT object.
   *
   * @param protectedHeader JWS Protected Header. Must contain an "alg"
   *     (JWS Algorithm) property.
   */
  setProtectedHeader(protectedHeader: JWTHeaderParameters) {
    // This has to be overridden to give us access to the protected header in
    // this subclass.
    super.setProtectedHeader(protectedHeader);
    this._pHeader = protectedHeader;
    return this;
  }

  concat(...buffers: Uint8Array[]): Uint8Array {
    const size = buffers.reduce((acc, {length}) => acc + length, 0);
    const buf = new Uint8Array(size);
    let i = 0;
    buffers.forEach(buffer => {
      buf.set(buffer, i);
      i += buffer.length;
    });
    return buf;
  }

  async signCustom(
    signer: (x: Uint8Array) => Promise<Uint8Array>
  ): Promise<string> {
    if (!this._pHeader) {
      throw new Error('OPR JWTs must specify a signing algorithm');
    }
    if (
      Array.isArray(this._pHeader?.crit) &&
      this._pHeader?.crit.includes('b64') &&
      // @ts-expect-error Copied from SignJWT logic
      this._pHeader?.b64 === false
    ) {
      throw new Error('JWTs MUST NOT use unencoded payload');
    }

    const encoder = new TextEncoder();
    const urlEncodedPayload = base64url.encode(JSON.stringify(this._payload));
    const encodedPayload = encoder.encode(urlEncodedPayload);
    const urlEncodedHeader = base64url.encode(JSON.stringify(this._pHeader));
    const encodedHeader = encoder.encode(urlEncodedHeader);
    const data = this.concat(
      encodedHeader,
      encoder.encode('.'),
      encodedPayload
    );
    const sig = await signer(data);
    const urlEncodedSig = base64url.encode(sig);
    return urlEncodedHeader + '.' + urlEncodedPayload + '.' + urlEncodedSig;
  }
}
