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

import {
  AcceptOfferResponse,
  HistoryResponse,
  Offer,
  OfferHistory,
} from 'opr-models';
import {HandlerRegistration} from '../model/handlerregistration';
import {Interval} from '../model/interval';
import {OfferChange} from '../model/offerchange';
import {asStructuredId, getIdVersion, OfferId} from '../model/offerid';
import {TimelineEntry} from '../model/timelineentry';
import {IntegrationApi} from '../integrations/integrationapi';
import {OprNetworkClient} from '../net/oprnetworkclient';
import {PersistentStorage} from '../database/persistentstorage';
import {CustomRequestHandler} from './customrequesthandler';
import {Clock} from '../util/clock';
import {DefaultClock} from '../util/defaultclock';
import {StatusError} from '../util/statuserror';
import {Logger, log} from '../util/loglevel';
import {OfferModel} from '../model/offermodel';
import {OfferProducer} from '../offerproducer/offerproducer';
import {NextFunction, Request, Response, Router} from 'express';
import {JsonValue} from '../util/jsonvalue';
import {OprTenantNode} from './oprtenantnode';

export interface IntegrationApiImplOptions {
  hostOrgUrl: string;
  storage: PersistentStorage;
  netClient?: OprNetworkClient;
  model: OfferModel;
  host: OprTenantNode;
  clock?: Clock;
  logger?: Logger;
  router?: Router;
}

/**
 * The default implementation of the Integration API that pulls together all the
 * storage, model, network and server functionality necessary to build a useful
 * integration.
 */
export class IntegrationApiImpl implements IntegrationApi {
  readonly hostOrgUrl: string;
  private storage: PersistentStorage;
  private netClient?: OprNetworkClient;
  private host: OprTenantNode;
  private clock: Clock;
  private model: OfferModel;
  private logger: Logger;
  private modelRegistration: HandlerRegistration;
  private changeHandlers: Array<(change: OfferChange) => Promise<void>>;
  private router: Router;
  private children: IntegrationApi[];

  constructor(options: IntegrationApiImplOptions) {
    this.hostOrgUrl = options.hostOrgUrl;
    this.storage = options.storage;
    this.netClient = options.netClient;
    this.host = options.host;
    this.router = options.router ?? this.host.getRouter();
    this.clock = options.clock ?? new DefaultClock();
    this.model = options.model;
    this.logger = options.logger ?? log.getLogger('OprClient');
    this.modelRegistration = this.model.registerChangeHandler(change =>
      this.fireChange(change)
    );
    this.changeHandlers = [];
    this.children = [];
  }

  namespacedClone(pathNamespace: string) {
    if (pathNamespace.startsWith('/')) {
      pathNamespace = pathNamespace.substring(1);
    }
    if (!pathNamespace.endsWith('/')) {
      pathNamespace += '/';
    }
    if (pathNamespace === '/') {
      pathNamespace = '';
    }
    // TODO: Build a wrapper around the Router so installations can be logged.
    const newRouter = Router();
    (newRouter as unknown as Record<string, string>).cloneNamespace =
      pathNamespace;
    const newApi = new IntegrationApiImpl({
      hostOrgUrl: this.hostOrgUrl,
      storage: this.storage,
      host: this.host,
      router: newRouter,
      clock: this.clock,
      model: this.model,
      logger: this.logger,
      netClient: this.netClient,
    });
    this.router.use(
      '/' + pathNamespace,
      async (req: Request, res: Response, next: NextFunction) => {
        newRouter(req, res, next);
      }
    );
    this.children.push(newApi);
    return newApi;
  }

  destroy(): void {
    for (const child of this.children) {
      child.destroy();
    }
    this.modelRegistration.remove();
  }

  async storeValue(
    key: string,
    value: JsonValue
  ): Promise<JsonValue | undefined> {
    const t = await this.storage.createTransaction('READWRITE');
    const returnVal = await this.storage.storeValue(
      t,
      this.hostOrgUrl,
      key,
      value
    );
    await t.commit();
    return returnVal;
  }

  /**
   * Deletes all values stored with the given key prefix. Returns the number of
   * keys deleted if supported by the storage driver.
   */
  async clearAllValues(keyPrefix: string): Promise<number | undefined> {
    const t = await this.storage.createTransaction('READWRITE');
    const returnVal = await this.storage.clearAllValues(
      t,
      this.hostOrgUrl,
      keyPrefix
    );
    await t.commit();
    return returnVal;
  }

  /**
   * Returns all values for the given host where the key starts with the given
   * prefix.
   */
  async *getValues(keyPrefix: string): AsyncIterable<JsonValue> {
    const t = await this.storage.createTransaction('READONLY');
    const asyncIterator = this.storage.getValues(t, this.hostOrgUrl, keyPrefix);
    for await (const x of asyncIterator) {
      yield x;
    }
  }

  async getOffer(offer: OfferId): Promise<Offer | undefined> {
    // If we were already given an offer, return it.
    if ((offer as Offer).offeredBy) {
      return offer as Offer;
    }
    const t = await this.storage.createTransaction('READONLY');
    const offerId = asStructuredId(offer);
    return await this.storage.getOffer(
      t,
      this.hostOrgUrl,
      offerId.id,
      offerId.postingOrgUrl,
      getIdVersion(offerId)
    );
  }

  async *getListedOffers(
    orgUrl: string,
    atTimeUTC: number = this.clock.now()
  ): AsyncIterable<Offer> {
    const t = await this.storage.createTransaction('READONLY');
    const iterable = this.storage.getOffersAtTime(
      t,
      this.hostOrgUrl,
      orgUrl,
      atTimeUTC
    );
    for await (const result of iterable) {
      yield result;
    }
  }

  async *getTimelineForOffer(
    offer: OfferId,
    queryInterval?: Interval | undefined
  ): AsyncIterable<TimelineEntry> {
    const t = await this.storage.createTransaction('READONLY');
    const offerId = asStructuredId(offer);
    const iterable = this.storage.getTimelineForOffer(
      t,
      this.hostOrgUrl,
      offerId.id,
      offerId.postingOrgUrl,
      queryInterval
    );
    for await (const result of iterable) {
      yield result;
    }
  }

  async *getOffersFromThisHost(): AsyncIterable<Offer> {
    const t = await this.storage.createTransaction('READONLY');
    const iterable = this.storage.getCorpusOffers(
      t,
      this.hostOrgUrl,
      this.hostOrgUrl
    );
    for await (const result of iterable) {
      yield result;
    }
  }

  ingestOffers(): Promise<void> {
    return this.host.ingest();
  }

  async accept(offerId: OfferId): Promise<Offer> {
    if (!this.netClient) {
      throw new StatusError(
        'No network client is available',
        'INTEGRATION_CLIENT_ERROR_NO_NETWORK_CLIENT'
      );
    }
    const t = await this.storage.createTransaction('READONLY');
    const structured = asStructuredId(offerId);
    const reshareChain = await this.storage.getBestAcceptChain(
      t,
      this.hostOrgUrl,
      structured.id,
      structured.postingOrgUrl
    );
    const result = await this.netClient.exec(
      'ACCEPT',
      structured.postingOrgUrl,
      {
        offerId: structured.id,
        ifNotNewerThanTimestampUTC: getIdVersion(structured),
        reshareChain: reshareChain,
      }
    );
    const acceptedOffer = (result as AcceptOfferResponse).offer;
    await this.fireChange({
      oldValue: acceptedOffer,
      newValue: acceptedOffer,
      type: 'REMOTE_ACCEPT',
      timestampUTC: this.clock.now(),
    });
    return acceptedOffer;
  }

  async reject(offerId: OfferId): Promise<Offer> {
    if (!this.netClient) {
      throw new StatusError(
        'No network client is available',
        'INTEGRATION_CLIENT_ERROR_NO_NETWORK_CLIENT'
      );
    }

    const offer = await this.getOffer(offerId);
    const structured = asStructuredId(offerId);
    if (!offer) {
      throw new StatusError(
        `Cannot reject unknown offer ${structured.id}`,
        'REJECT_ERROR_UNKNOWN_OFFER',
        400
      );
    }
    const t = await this.storage.createTransaction('READONLY');
    const sources = await this.storage.getOfferSources(
      t,
      this.hostOrgUrl,
      structured.id,
      structured.postingOrgUrl
    );
    const promises = [];
    for (const sourceOrgUrl of sources) {
      promises.push(
        this.netClient.exec('REJECT', sourceOrgUrl, {
          offerId: structured.id,
          offeredByUrl: structured.postingOrgUrl,
        })
      );
    }
    await Promise.all(promises);
    await this.fireChange({
      oldValue: offer,
      newValue: offer,
      type: 'REMOTE_REJECT',
      timestampUTC: this.clock.now(),
    });
    return offer;
  }

  async reserve(
    offerId: OfferId,
    requestedReservationSecs: number
  ): Promise<Offer> {
    if (!this.netClient) {
      throw new StatusError(
        'No network client is available',
        'INTEGRATION_CLIENT_ERROR_NO_NETWORK_CLIENT'
      );
    }
    const structured = asStructuredId(offerId);
    const t = await this.storage.createTransaction('READONLY');
    const reshareChain = await this.storage.getBestAcceptChain(
      t,
      this.hostOrgUrl,
      structured.id,
      structured.postingOrgUrl
    );
    const result = await this.netClient.exec(
      'RESERVE',
      structured.postingOrgUrl,
      {
        offerId: structured.id,
        requestedReservationSecs: requestedReservationSecs,
        reshareChain: reshareChain,
      }
    );
    const offer = (result as AcceptOfferResponse).offer;
    await this.fireChange({
      oldValue: offer,
      newValue: offer,
      type: 'REMOTE_RESERVE',
      timestampUTC: this.clock.now(),
    });
    return offer;
  }

  async *getLocalAcceptHistory(
    sinceTimestampUTC?: number | undefined
  ): AsyncIterable<OfferHistory> {
    const t = await this.storage.createTransaction('READONLY');
    const iterable = this.storage.getHistory(
      t,
      this.hostOrgUrl,
      this.hostOrgUrl,
      sinceTimestampUTC
    );
    for await (const result of iterable) {
      yield result;
    }
  }

  async *getRemoteAcceptHistory(
    remoteOrgUrl: string,
    sinceTimestampUTC?: number | undefined
  ): AsyncIterable<OfferHistory> {
    if (!this.netClient) {
      throw new StatusError(
        'No network client is available',
        'INTEGRATION_CLIENT_ERROR_NO_NETWORK_CLIENT'
      );
    }
    let pageToken;
    do {
      const result = (await this.netClient.exec('HISTORY', remoteOrgUrl, {
        historySinceUTC: sinceTimestampUTC,
        pageToken: pageToken,
      })) as HistoryResponse;
      for (const history of result.offerHistories) {
        yield history;
      }
      pageToken = result.nextPageToken;
    } while (pageToken !== undefined);
  }

  private async fireChange(change: OfferChange): Promise<void> {
    try {
      await Promise.all(
        this.changeHandlers.map(handlerFn => handlerFn(change))
      );
    } catch (e) {
      this.logger.error('Error in change handler', e);
    }
  }

  registerChangeHandler(
    handlerFn: (change: OfferChange) => Promise<void>
  ): HandlerRegistration {
    this.changeHandlers.push(handlerFn);
    return new OprClientHandlerRegistration(handlerFn, this.changeHandlers);
  }

  installOfferProducer(producer: OfferProducer): void {
    this.host.installOfferProducer(producer);
  }

  getExpressRouter(): Router {
    return this.router;
  }

  installCustomHandler(path: string, handler: CustomRequestHandler) {
    if (this.host.isStarted()) {
      throw new StatusError(
        'Cannot install custom handlers after the server has started',
        'SERVER_ERROR_INSTALL_CUSTOM_HANDLER'
      );
    }
    const expressHandler = async (req: Request, res: Response) => {
      this.logger.info('Called custom handler', path);
      res.json(await handler.handle(req.body as unknown, req, this));
    };
    path = path.startsWith('/') ? path : '/' + path;
    const methods = Array.isArray(handler.method)
      ? handler.method
      : handler.method ?? 'POST';
    if (methods.indexOf('GET') >= 0) {
      this.getExpressRouter().get(path, expressHandler);
    }
    if (methods.indexOf('POST') >= 0) {
      this.getExpressRouter().post(path, expressHandler);
    }
  }
}

class OprClientHandlerRegistration implements HandlerRegistration {
  private changeHandlers: Array<(change: OfferChange) => Promise<void>>;
  private handler: (change: OfferChange) => Promise<void>;

  constructor(
    handler: (change: OfferChange) => Promise<void>,
    changeHandlers: Array<(change: OfferChange) => Promise<void>>
  ) {
    this.changeHandlers = changeHandlers;
    this.handler = handler;
  }

  remove(): void {
    const index = this.changeHandlers.indexOf(this.handler);
    this.changeHandlers.splice(index, 1);
  }
}
