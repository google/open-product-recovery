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
import type {Request} from 'express';
import {
  CustomRequestHandler,
  CustomRequestMethod,
  IntegrationApi,
} from 'opr-core';
import {IamAccessControlList} from './iamaccesscontrollist';
import {checkIamAuth} from './checkiamauth';

/**
 * Wraps a custom endpoint in an IAM credential checker. This can be used to
 * ensure that requests are coming from an authorized IAM user (usually a
 * service account) from Google Cloud.
 */
export class IamCustomEndpointWrapper implements CustomRequestHandler {
  readonly method?: Array<CustomRequestMethod> | CustomRequestMethod;
  private readonly delegate: CustomRequestHandler;
  private readonly acl: IamAccessControlList;

  constructor(delegate: CustomRequestHandler, acl: IamAccessControlList) {
    this.delegate = delegate;
    this.acl = acl;
    this.method = delegate.method;
  }

  async handle(
    body: unknown,
    req: Request,
    integrationClient: IntegrationApi
  ): Promise<unknown> {
    await checkIamAuth(req, this.acl);
    return await this.delegate.handle(body, req, integrationClient);
  }

  static wrap(delegate: CustomRequestHandler, acl: IamAccessControlList) {
    return new IamCustomEndpointWrapper(delegate, acl);
  }
}
