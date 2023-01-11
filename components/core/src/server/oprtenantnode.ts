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

import {Request, Response, Router} from 'express';
import {OprNetworkClient} from '../net/oprnetworkclient';
import {OfferProducer, OfferSetUpdate} from '../offerproducer/offerproducer';
import {OprFeedProducer} from '../offerproducer/oprfeedproducer';
import {FeedConfig} from '../policy/feedconfig';
import {StatusError} from '../util/statuserror';
import loglevel, {Logger} from '../util/loglevel';
import {Clock} from '../util/clock';
import {DefaultClock} from '../util/defaultclock';
import {OfferModel} from '../model/offermodel';
import {PersistentStorage} from '../database/persistentstorage';
import {PersistentOfferModel} from '../model/persistentoffermodel';
import {OfferListingPolicy} from '../policy/offerlistingpolicy';
import {Signer} from '../auth/signer';
import {ListOffersPayload} from 'opr-models';
import {OrgConfig} from '../config/orgconfig';
import {JWTPayload, JWTVerifyOptions} from 'jose';
import {getBearerToken} from '../auth/getbearertoken';
import {Verifier} from '../auth/verifier';
import {AuthenticatedRequestHandler} from './handlers/authenticatedrequesthandler';
import {OrgConfigProvider} from '../config/orgconfigprovider';
import {ServerAccessControlList} from '../policy/serveraccesscontrollist';
import {HistoryRequestHandler} from './handlers/historyrequesthandler';
import {ListRequestHandler} from './handlers/listrequesthandler';
import {AcceptRequestHandler} from './handlers/acceptrequesthandler';
import {RejectRequestHandler} from './handlers/rejectrequesthandler';
import {ReserveRequestHandler} from './handlers/reserverequesthandler';
import {JwksProvider} from '../auth/jwksprovider';
import {TenantNodeIntegrationInstaller} from '../integrations/tenantnodeintegrationinstaller';
import {IntegrationApiImpl} from './integrationapiimpl';
import {StandardVerifier} from '../auth/standardverifier';
import {TenantNodeConfig} from '../config/tenantnodeconfig';

const DEFAULT_RESERVATION_TIME_SECS = 5 * 60;

export class OprTenantNode {
  readonly hostOrgUrl: string;
  readonly hostUrlRoot: string;
  readonly name: string;
  private enrollmentUrl?: string;
  private jwksURL: string;
  private listProductsPath: string;
  private acceptProductPath: string;
  private reserveProductPath: string;
  private rejectProductPath: string;
  private historyPath: string;

  private router: Router;
  private offerProducers: OfferProducer[];
  private feedConfigs: FeedConfig[];
  private networkClient?: OprNetworkClient;
  private storage: PersistentStorage;
  private offerModel: OfferModel;
  private listingPolicy: OfferListingPolicy;
  private signer: Signer;
  private verifier: Verifier;
  private remoteConfigProvider: OrgConfigProvider;
  private orgFilePath: string;
  private jwksProvider?: JwksProvider;
  private accessControlList: ServerAccessControlList;
  private integrationInstallers: TenantNodeIntegrationInstaller[];
  private integrationApi: IntegrationApiImpl;

  private defaultReservationTimeSecs: number;
  private strictCorrectnessChecks: boolean;
  private orgConfig: OrgConfig;
  private clock: Clock;
  private logger: Logger;

  private isStartedInternal: boolean;

  constructor(config: TenantNodeConfig, storage: PersistentStorage) {
    if (!config.hostOrgUrl) {
      throw new StatusError('Host org url must be set', 'NO_HOST_ORG_URL');
    }
    this.hostOrgUrl = config.hostOrgUrl;
    this.hostUrlRoot = config.hostUrlRoot;
    this.name = config.name;
    this.isStartedInternal = false;
    this.clock = config.clock || new DefaultClock();
    this.router = Router({
      mergeParams: true,
    });
    this.router.use('/', (req, res, next) => {
      next();
    });
    this.offerProducers = [...(config.producers ?? [])];
    this.feedConfigs = [...(config.feedConfigs ?? [])].map(f =>
      typeof f === 'string'
        ? {
            organizationUrl: f,
            maxUpdateFrequencyMillis: 10 * 60 * 1000 /* ten minutes */,
          }
        : (f as unknown as FeedConfig)
    );
    this.listingPolicy = config.listingPolicy;
    this.signer = config.signer;
    this.orgFilePath = config.orgFilePath ?? '/org.json';
    this.enrollmentUrl = config.enrollmentURL;
    this.listProductsPath = config.listProductsPath ?? '/api/list';
    this.acceptProductPath = config.acceptProductPath ?? '/api/accept';
    this.reserveProductPath = config.reserveProductPath ?? '/api/reserve';
    this.rejectProductPath = config.rejectProductPath ?? '/api/reject';
    this.historyPath = config.historyPath ?? '/api/history';
    this.jwksURL = config.jwksFilePath ?? '/jwks.json';
    this.jwksProvider = config.jwks;
    this.defaultReservationTimeSecs =
      config.defaultReservationTimeSecs ?? DEFAULT_RESERVATION_TIME_SECS;
    this.accessControlList = config.accessControlList;
    this.remoteConfigProvider =
      config.orgConfigProvider ?? new OrgConfigProvider();
    this.verifier =
      config.verifier ?? new StandardVerifier(this.remoteConfigProvider);
    this.networkClient = new OprNetworkClient({
      configProvider: this.remoteConfigProvider,
      signer: this.signer,
    });
    this.storage = storage;
    this.offerModel = new PersistentOfferModel({
      hostOrgUrl: this.hostOrgUrl,
      listingPolicy: this.listingPolicy,
      storage: storage,
      clock: this.clock,
      signer: this.signer,
    });
    this.integrationInstallers = config.integrations ?? [];
    this.orgConfig = {
      name: this.name,
      organizationURL: this.hostOrgUrl,
      enrollmentURL: this.enrollmentUrl,
      listProductsEndpointURL: this.pathToUrl(this.listProductsPath),
      acceptProductsEndpointURL: this.pathToUrl(this.acceptProductPath),
      reserveProductsEndpointURL: this.pathToUrl(this.reserveProductPath),
      rejectProductsEndpointURL: this.pathToUrl(this.rejectProductPath),
      acceptHistoryEndpointURL: this.pathToUrl(this.historyPath),
      jwksURL: this.getJwksUrl(),
      scopesSupported: true,
    };
    this.logger =
      config.logger ?? loglevel.getLogger(`OprHost ${this.hostOrgUrl}`);
    this.strictCorrectnessChecks = config.strictCorrectnessChecks ?? false;
    this.integrationApi = new IntegrationApiImpl({
      host: this,
      hostOrgUrl: this.hostOrgUrl,
      model: this.offerModel,
      storage: this.storage,
      clock: this.clock,
      netClient: this.networkClient,
    });
    this.serveOrgFile();
    this.maybeServeJwks();
    this.serveApiEndpoints();
  }

  private getPathFromModuleName(moduleName: string) {
    return moduleName.toLowerCase().replace(/[./]/g, '').replace(/#/g, '/');
  }

  async start(): Promise<void> {
    const promises = [];
    for (const installer of this.integrationInstallers) {
      const path =
        installer.mountPath ??
        'integrations/' +
          this.getPathFromModuleName(installer.factoryNameSource!);
      const api = this.integrationApi.namespacedClone(path);
      promises.push(installer.install(api));
    }
    await Promise.all(promises);
    this.isStartedInternal = true;
  }

  async destroy(): Promise<void> {
    await Promise.all(
      this.integrationInstallers.map(async f =>
        f.uninstall ? await f.uninstall(this.integrationApi) : undefined
      )
    );
    this.integrationApi.destroy();
  }

  installOfferProducer(offerProducer: OfferProducer): void {
    this.offerProducers.push(offerProducer);
  }

  installFeedConfig(feedConfig: FeedConfig): void {
    this.feedConfigs.push(feedConfig);
  }

  private async getFeedProducers(): Promise<Array<OfferProducer>> {
    return this.feedConfigs.map(feedConfig =>
      this.getOfferProducerFromFeedConfig(feedConfig)
    );
  }

  private getOfferProducerFromFeedConfig(
    feedConfig: FeedConfig
  ): OfferProducer {
    if (!this.networkClient) {
      throw new StatusError(
        'An OPR client must be specified to install feeds',
        'SERVER_CONFIG_ERROR_NO_OPR_CLIENT',
        500
      );
    }
    return new OprFeedProducer(
      this.networkClient,
      feedConfig.organizationUrl,
      feedConfig.maxUpdateFrequencyMillis
    );
  }

  async ingest(): Promise<void> {
    this.logger.info('Ingesting offers');
    const producers = [
      ...(await this.getFeedProducers()),
      ...this.offerProducers,
    ];
    this.logger.info(
      'Found producers:',
      producers.map(p => p.id)
    );
    for (const producer of producers) {
      await this.produceOffers(producer);
    }
    this.logger.info('Ingestion complete');
  }

  private async produceOffers(producer: OfferProducer): Promise<void> {
    this.logger.info('Ingesting offers from', producer.id);
    // Note: If there's already a request in process, locking the producer will
    // throw an exception that cancels this entire operation.
    this.logger.debug('Obtaining lock on', producer.id);
    let metadata;
    try {
      metadata = await this.offerModel.getOfferProducerMetadata(producer.id);
    } catch (e) {
      this.logger.warn(
        'Failed to obtain lock on',
        producer.id,
        'update frequency may be too high',
        e
      );
      return;
    }
    this.logger.debug('Lock obtained on', producer.id);
    const now = this.clock.now();
    let nextRunTimestampUTC = metadata?.nextRunTimestampUTC;
    let result: OfferSetUpdate | undefined;
    try {
      if (nextRunTimestampUTC && nextRunTimestampUTC > now) {
        this.logger.info(
          'Skipping feed',
          producer.id,
          ', cannot fetch again for',
          nextRunTimestampUTC - now,
          'ms'
        );
        await this.offerModel.writeOfferProducerMetadata({
          lastUpdateTimeUTC: now,
          nextRunTimestampUTC: nextRunTimestampUTC ?? now,
          organizationUrl: producer.id,
        });
        return;
      }
      const diffStartTimestampUTC = metadata?.lastUpdateTimeUTC;
      let listPayload: ListOffersPayload;
      if (diffStartTimestampUTC !== undefined) {
        listPayload = {
          requestedResultFormat: 'DIFF',
          diffStartTimestampUTC: metadata?.lastUpdateTimeUTC,
        };
      } else {
        listPayload = {
          requestedResultFormat: 'SNAPSHOT',
        };
      }
      result = await producer.produceOffers(listPayload);
      nextRunTimestampUTC = result.earliestNextRequestUTC;
      await this.offerModel.processUpdate(producer.id, result);
      await this.offerModel.writeOfferProducerMetadata({
        lastUpdateTimeUTC: now,
        nextRunTimestampUTC: nextRunTimestampUTC ?? now,
        organizationUrl: producer.id,
      });
      this.logger.info('Ingestion of', producer.id, 'succeeded');
      this.logger.debug('dbg Lock released on', producer.id);
    } catch (e) {
      this.logger.warn('Failed to fetch', producer.id, 'error:', e);
      nextRunTimestampUTC =
        now + this.getFailedRetryIntervalMillis(producer.id);
      await this.offerModel.writeOfferProducerMetadata({
        lastUpdateTimeUTC: metadata?.lastUpdateTimeUTC,
        nextRunTimestampUTC: nextRunTimestampUTC ?? now,
        organizationUrl: producer.id,
      });
      this.logger.debug('Lock released on', producer.id);
    }
  }

  /**
   * Returns the minimum number of milliseconds to wait before retrying a
   * failed request from a producer. This takes the producer id so that
   * a producer-specific backoff policy can be implemented.
   */
  protected getFailedRetryIntervalMillis(producerId: string): number {
    // TODO: Build a useful, per-producer backoff policy.
    return 10 * 1000 /* 10 seconds */;
  }

  private pathToUrl(path?: string): string | undefined {
    if (path === undefined) {
      return undefined;
    }
    const baseUrl = new URL('./', this.hostOrgUrl);
    if (path.startsWith('/')) {
      path = '.' + path;
    }
    return new URL(path, baseUrl).toString();
  }

  private getJwksUrl(): string | undefined {
    if (!this.jwksURL) {
      return undefined;
    }
    const testUrl = new URL(this.jwksURL, 'http://localhost');
    if (testUrl.hostname === 'localhost') {
      return this.pathToUrl('.' + testUrl.pathname);
    }
    return this.jwksURL;
  }

  private getOrgConfig(): OrgConfig {
    return this.orgConfig;
  }

  serveOrgFile(): void {
    const orgFilePath = this.orgFilePath;

    const orgJson = this.getOrgConfig();
    this.router.get(orgFilePath, async (req, res) => {
      res.json(orgJson);
    });
  }

  maybeServeJwks(): void {
    if (this.jwksURL) {
      const testUrl = new URL(this.jwksURL, 'http://localhost');
      if (testUrl.hostname === 'localhost') {
        // If the jwksURL is just a pathname, we need to host the
        // key set.
        const jwks = this.jwksProvider;
        if (!jwks) {
          throw new StatusError(
            'No jwksProvider specified. A JWKS provider is required if the ' +
              'frontend server is hosting the JWKS file.',
            'NO_JWKS_PROVIDER'
          );
        }
        this.router.get(testUrl.pathname, async (req, res) => {
          res.send(await jwks.getJwks());
        });
      }
    }
  }

  getRouter(): Router {
    return this.router;
  }

  serveApiEndpoints(): void {
    this.router.post(this.listProductsPath, async (req, res) => {
      return await this.handleList(req, res);
    });
    this.router.post(this.acceptProductPath, (req, res) => {
      return this.handleAccept(req, res);
    });
    this.router.post(this.rejectProductPath, (req, res) => {
      return this.handleReject(req, res);
    });
    this.router.post(this.reserveProductPath, (req, res) => {
      return this.handleReserve(req, res);
    });
    this.router.post(this.historyPath, (req, res) => {
      return this.handleHistory(req, res);
    });
  }

  isStarted(): boolean {
    return this.isStartedInternal;
  }

  async checkAuth(
    req: Request,
    options?: JWTVerifyOptions
  ): Promise<JWTPayload> {
    options = {...options, currentDate: new Date(this.clock.now())};
    const token = getBearerToken(req.header('Authorization'));
    const payload = (await this.verifier.verify(token, options)).payload;
    return payload;
  }

  async handleAuthenticatedRequest<RequestType, ResponseType>(
    req: Request,
    res: Response,
    requestHandler: AuthenticatedRequestHandler<RequestType, ResponseType>
  ): Promise<void> {
    // Check the token.
    const jwtPayload = await this.checkAuth(req);
    // Check for required fields.
    if (!jwtPayload.iss) {
      throw new StatusError(
        'Auth token does not specify the required iss field',
        'AUTH_ERROR_ISS_MISSING',
        401
      );
    }
    if (jwtPayload.aud) {
      if (jwtPayload.aud !== this.hostOrgUrl) {
        // TODO(johndayrichter): Add support for a list of additional
        // acceptable org urls to allow for smooth URL changes.
        throw new StatusError(
          'Auth token audience is ' +
            jwtPayload.aud +
            ', but this server' +
            'requires audience ' +
            this.hostOrgUrl,
          'AUTH_ERROR_AUD_INVALID',
          401
        );
      }
    } else {
      throw new StatusError(
        'Auth token does not specify the required aud field',
        'AUTH_ERROR_AUD_MISSING',
        401
      );
    }
    // Check the scopes
    const jwtScopes = ((jwtPayload['scope'] as string) || '').split(' ');
    for (const scope of requestHandler.scopes || []) {
      if (jwtScopes.indexOf(scope) < 0) {
        throw new StatusError(
          'Auth token is missing required scope ' + scope,
          'AUTH_ERROR_MISSING_SCOPE',
          403
        );
      }
    }
    // Check that the request is valid.
    const requestBody = req.body as unknown;
    requestHandler.validateRequest(requestBody);

    // Check the ACL, if appropriate
    if (!requestHandler.shouldIgnoreAccessControlList(requestBody)) {
      const matched = await this.accessControlList.isAllowed(jwtPayload.iss);
      if (!matched) {
        throw new StatusError(
          'Organization ' +
            jwtPayload.iss +
            ' does not have permission to access this server',
          'AUTH_ERROR_ORG_NOT_AUTHORIZED',
          403
        );
      }
    }

    const response = await requestHandler.handle(requestBody, jwtPayload);
    if (this.strictCorrectnessChecks) {
      requestHandler.validateResponse(response);
    }
    res.json(response);
  }

  async handleList(req: Request, res: Response): Promise<void> {
    this.logger.info('Handling request to list');
    await this.handleAuthenticatedRequest(
      req,
      res,
      new ListRequestHandler(this.offerModel)
    );
  }

  async handleAccept(req: Request, res: Response): Promise<void> {
    this.logger.info('Handling request to accept');
    await this.handleAuthenticatedRequest(
      req,
      res,
      new AcceptRequestHandler(this.offerModel, this.hostOrgUrl, this.verifier)
    );
  }

  async handleReject(req: Request, res: Response): Promise<void> {
    this.logger.info('Handling request to reject');
    await this.handleAuthenticatedRequest(
      req,
      res,
      new RejectRequestHandler(this.offerModel)
    );
  }

  async handleReserve(req: Request, res: Response): Promise<void> {
    this.logger.info('Handling request to reserve');
    await this.handleAuthenticatedRequest(
      req,
      res,
      new ReserveRequestHandler(
        this.offerModel,
        this.defaultReservationTimeSecs,
        this.hostOrgUrl,
        this.verifier
      )
    );
  }

  async handleHistory(req: Request, res: Response): Promise<void> {
    this.logger.info('Handling request to reserve');
    await this.handleAuthenticatedRequest(
      req,
      res,
      new HistoryRequestHandler(this.offerModel)
    );
  }
}
