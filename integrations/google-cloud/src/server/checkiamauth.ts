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

import type {Request} from 'opr-core';
import {IamAccessControlList} from './iamaccesscontrollist';
import {getBearerToken, StatusError} from 'opr-core';
import {OAuth2Client} from 'google-auth-library';

export async function checkIamAuth(
  req: Request,
  acl: IamAccessControlList
): Promise<void> {
  const token = getBearerToken(req.header('Authorization'));
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken: token,
  });
  const payload = ticket.getPayload();
  console.log('Decoded payload', payload);
  if (
    !payload ||
    !payload.email ||
    !(await acl.isAllowed(payload.email, payload))
  ) {
    throw new StatusError('Forbidden', 'ERROR_FORBIDDEN', 403);
  }
}
