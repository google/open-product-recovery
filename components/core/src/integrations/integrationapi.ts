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

import {Offer, OfferHistory} from 'opr-models';
import {HandlerRegistration} from '../model/handlerregistration';
import {Interval} from '../model/interval';
import {OfferChange} from '../model/offerchange';
import {OfferId} from '../model/offerid';
import {TimelineEntry} from '../model/timelineentry';
import {CustomRequestHandler} from '../server/customrequesthandler';
import {IRouter} from 'express';
import {JsonValue} from '../util/jsonvalue';
import {OfferProducer} from '../offerproducer/offerproducer';

/**
 * An API used by OPR integrations. This API is passed to custom startup
 * routines and custom handlers.
 */
export interface IntegrationApi {
  readonly hostOrgUrl: string;

  /**
   * Stores a key-value pair. If a value already exists at the given key, it
   * will be replaced and the old value returned.
   */
  storeValue(key: string, value: JsonValue): Promise<JsonValue | undefined>;

  /**
   * Deletes all values stored with the given key prefix. Returns the number of
   * keys deleted if supported by the storage driver.
   */
  clearAllValues(keyPrefix: string): Promise<number | undefined>;

  /**
   * Returns all values for the given host where the key starts with the given
   * prefix.
   */
  getValues(keyPrefix: string): AsyncIterable<JsonValue>;

  /**
   * Returns the latest version of an offer (or a specific version of an offer,
   * if requested using a versioned offer id) if it is in stable storage. Note
   * that this method may return an offer that has no listings, is deleted, has
   * been accepted, or is expired.
   */
  getOffer(offer: OfferId): Promise<Offer | undefined>;

  /**
   * Returns the offers that are listed for a given target organization. If the
   * atTimeUTC parameter is specified, this method returns the offers that were
   * visible (or will be visible) at the given time.
   */
  getListedOffers(orgUrl: string, atTimeUTC?: number): AsyncIterable<Offer>;

  /**
   * Returns the timeline entries for a given offer. If queryInterval is
   * specified, this method will return timeline entries that fall within the
   * provided time interval.
   */
  getTimelineForOffer(
    offer: OfferId,
    queryInterval?: Interval
  ): AsyncIterable<TimelineEntry>;

  /** Returns all not-yet-expired, not-yet-accepted offers made by this host. */
  getOffersFromThisHost(): AsyncIterable<Offer>;

  /**
   * Ingests offers from other hosts. Note that this method will honor the
   * server's ingestion policy, and will not attempt to read offers from servers
   * that have already been checked recently.
   */
  ingestOffers(): Promise<void>;

  /**
   * Accepts the given offer. Note that this method will work if:
   * a) The entire Offer object is passed to this method
   * OR
   * b) Another offer identifier is passed to this method, AND this host has
   *    already ingested this offer from some OfferProvider.
   *
   * This method will reach out to the appropriate server to accept the offer.
   * If the given OfferId contains version information, this method will fail
   * if the remote server has a newer version of the offer than is specified in
   * the OfferId.
   */
  accept(offer: OfferId): Promise<Offer>;

  /**
   * Rejects the given offer from all servers that are publishing the offer to
   * this server. Note that this method will work if:
   * a) The entire Offer object is passed to this method
   * OR
   * b) Another offer identifier is passed to this method, AND this host has
   *    already ingested this offer from some OfferProvider.
   */
  reject(offer: OfferId): Promise<Offer>;

  /**
   * Reserves the given offer. Note that this method will work if:
   * a) The entire Offer object is passed to this method
   * OR
   * b) Another offer identifier is passed to this method, AND this host has
   *    already ingested this offer from some OfferProvider.
   */
  reserve(offer: OfferId, requestedReservationSecs: number): Promise<Offer>;

  /**
   * Returns the history of offers accepted FROM THIS HOST. If the
   * sinceTimestampUTC parameter is provided, this method will return only
   * offers accepted since the given timestamp.
   */
  getLocalAcceptHistory(
    sinceTimestampUTC?: number
  ): AsyncIterable<OfferHistory>;

  /**
   * Returns the history of offers accepted FROM THE GIVEN HOST. If the
   * sinceTimestampUTC parameter is provided, this method will return only
   * offers accepted since the given timestamp. Note that this will only return
   * offer histories that the current host is allowed to see.
   */
  getRemoteAcceptHistory(
    remoteOrgUrl: string,
    sinceTimestampUTC?: number
  ): AsyncIterable<OfferHistory>;

  /**
   * Registers a change handler.
   */
  registerChangeHandler(
    handlerFn: (change: OfferChange) => Promise<void>
  ): HandlerRegistration;

  /**
   * Returns the Express server running OPR. This can be used to install custom
   * middleware or perform other bare-metal customizations to the server. You
   * can easily break an OPR node by messing with the underlying server, so
   * only touch this if you really know what you're doing.
   */
  getExpressRouter(): IRouter;

  installCustomHandler(path: string, handler: CustomRequestHandler): void;

  installOfferProducer(producer: OfferProducer): void;

  destroy(): void;
}
