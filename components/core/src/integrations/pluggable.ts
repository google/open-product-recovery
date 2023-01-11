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

import {JwksProvider} from '../auth/jwksprovider';
import {Signer} from '../auth/signer';
import {OfferListingPolicy} from '../policy/offerlistingpolicy';
import {JsonMap} from '../util/jsonvalue';
import {ServerAccessControlList} from '../policy/serveraccesscontrollist';
import {FeedConfig} from '../policy/feedconfig';
import {OfferProducer} from '../offerproducer/offerproducer';
import {Verifier} from '../auth/verifier';
import {TenantNodeIntegrationInstaller} from './tenantnodeintegrationinstaller';
import {PersistentStorage} from '../database/persistentstorage';
import {TenantNodeConfigProvider} from '../config/tenantnodeconfigprovider';
import {TenantIdExtractor} from '../config/tenantidextractor';
import {PluggableFactorySet} from './pluggablefactoryset';

export type TenantNodePluggableTypeName = keyof TenantNodePluggableTypeMap;

export interface TenantNodePluggableTypeMap {
  listingPolicy: OfferListingPolicy;
  signer: Signer;
  jwksProvider: JwksProvider;
  accessControlList: ServerAccessControlList;
  feedConfigProvider: FeedConfig;
  offerProducer: OfferProducer;
  verifier: Verifier;
  integrationInstaller: TenantNodeIntegrationInstaller;
}

export interface ServerPluggableTypeMap {
  storage: PersistentStorage;
  tenantConfigProvider: TenantNodeConfigProvider<PluggableFactorySet>;
  tenantIdExtractor: TenantIdExtractor;
}

export type PluggableTypeMap = TenantNodePluggableTypeMap &
  ServerPluggableTypeMap;

export type ServerPluggableTypeName = keyof ServerPluggableTypeMap;

export type PluggableTypeName =
  | ServerPluggableTypeName
  | TenantNodePluggableTypeName;

export interface Pluggable {
  readonly type: PluggableTypeName;
  factoryNameSource?: string;
  destroy?(): Promise<void>;
}
