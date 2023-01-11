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
  DecodedReshareChain,
  Offer,
  OfferHistory,
  ReshareChain,
} from 'opr-models';
import {Pluggable} from '../integrations/pluggable';
import {Interval} from '../model/interval';
import {TimelineEntry} from '../model/timelineentry';
import {OfferProducerMetadata} from '../offerproducer/offerproducermetadata';
import {JsonValue} from '../util/jsonvalue';
import {Transaction} from './transaction';
export type PersistentStorageUpdateType = 'NONE' | 'ADD' | 'UPDATE' | 'DELETE';
export type TransactionType = 'READONLY' | 'READWRITE';

/**
 * A persistent storage API, used as a storage driver for a
 * PersistentOfferModel. Each operation in this API is meant to be entirely
 * self-contained and orchestrated from the outside. In most cases,
 * implementations of methods in this class should not call other methods in
 * this class.
 */
export interface PersistentStorage extends Pluggable {
  readonly type: 'storage';

  createTransaction(type?: TransactionType): Promise<Transaction>;

  /**
   * Stores a key-value pair for the given host. If a value already exists at
   * the given key, it will be replaced and the old value returned.
   */
  storeValue(
    t: Transaction,
    hostOrgUrl: string,
    key: string,
    value: JsonValue
  ): Promise<JsonValue | undefined>;

  /**
   * Clears all values for the given host where the key starts with the given
   * prefix. It is very important to namespace keys correctly, since this can
   * easily erase many values. Returns the number of values deleted if supported
   * by the storage driver.
   */
  clearAllValues(
    t: Transaction,
    hostOrgUrl: string,
    keyPrefix: string
  ): Promise<number | undefined>;

  /**
   * Returns all values for the given host where the key starts with the given
   * prefix.
   */
  getValues(
    t: Transaction,
    hostOrgUrl: string,
    keyPrefix: string
  ): AsyncIterable<JsonValue>;

  /**
   * Adds or updates the given offer in the corpus. Returns an update type flag
   * that indicates how the update affects the global set of offers. For
   * example, if a new offer is added to a corpus, but that offer is already
   * present in some _other_ corpus, this method would return NONE.
   */
  insertOrUpdateOfferInCorpus(
    t: Transaction,
    hostOrgUrl: string,
    requestingOrgUrl: string,
    offer: Offer
  ): Promise<PersistentStorageUpdateType>;

  /**
   * Deletes the given offer from the corpus. Returns an update type flag
   * that indicates how the deletion affects the global set of offers. For
   * example, if an offer is deleted from a corpus but it's still present in
   * some other corpus, the offer remains in the complete offer set, so the
   * offer update type is NONE.
   */
  deleteOfferInCorpus(
    t: Transaction,
    hostOrgUrl: string,
    requestingOrgUrl: string,
    offerId: string,
    offeringOrgUrl: string
  ): Promise<PersistentStorageUpdateType>;

  /**
   * Returns the version of the given offer id in the given corpus, or undefined
   * if that offer cannot be found in that corpus.
   */
  getOfferFromCorpus(
    t: Transaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    postingOrgUrl: string,
    offerId: string
  ): Promise<Offer | undefined>;

  /**
   * Returns the latest version of an offer (or a specific version of an offer,
   * if updateTimestampUTC is provided) if it is in stable storage. This method
   * may return an offer that has no listings, that has been deleted from every
   * corpus, or is expired.
   */
  getOffer(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    updateTimestampUTC?: number
  ): Promise<Offer | undefined>;

  /**
   * Returns the organization urls of all organizations that are currently
   * publishing this offer to this server.
   */
  getOfferSources(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    updateTimestampUTC?: number
  ): Promise<Array<string>>;

  /**
   * Returns the best reshare chain to use as a root for resharing the given
   * offer. If the result is undefined, it means no suitable reshare chain
   * could be found.
   */
  getBestReshareChainRoot(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string
  ): Promise<ReshareChain | undefined>;

  /**
   * Returns the best reshare chain to use to accept the given offer. If the
   * result is undefined, it means either:
   * - no reshare chain is needed to accept the offer.
   * - there is no offer with the given id.
   */
  getBestAcceptChain(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string
  ): Promise<ReshareChain | undefined>;

  /**
   * Returns an AsyncIterable of Offers in a given corpus. If a skipCount is
   * provided, the given number of items in the corpus are automatically
   * skipped. Implementations will avoid fetching skipped items if possible.
   * Offers will always be returned in ascending order of postingOrgUrl and
   * offer id.
   */
  getCorpusOffers(
    t: Transaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    skipCount?: number
  ): AsyncIterable<Offer>;

  /**
   * Returns the complete timeline for an offer. The timeline may be optionally
   * filtered to a single organization, and to entries that intersect a given
   * interval.
   *
   * Timeline entries will be sorted by:
   * startTime, postingOrgUrl, offerId, targetOrgUrl
   */
  getTimelineForOffer(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    queryInterval?: Interval,
    targetOrgUrl?: string
  ): AsyncIterable<TimelineEntry>;

  /**
   * Adds a collection of timeline entries. Newly added timeline entries must
   * not conflict with existing entries. This is typically guaranteed by
   * truncating the timeline before adding new entries.
   */
  addTimelineEntries(
    t: Transaction,
    hostOrgUrl: string,
    timelineEntries: AsyncIterable<TimelineEntry>
  ): Promise<void>;

  /**
   * Deletes all timeline entries for the given offer after the given time.
   * Timeline entries that span the timestamp will be shortened to end at
   * the given time.
   */
  truncateFutureTimelineForOffer(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    timestampUTC: number
  ): Promise<void>;

  /**
   * Returns all offers visible to the given organization at the given time.
   */
  getOffersAtTime(
    t: Transaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    timestampUTC: number,
    skipCount?: number,
    pageSize?: number
  ): AsyncIterable<Offer>;

  /**
   * Returns the version of an offer visible to the given organization at the
   * given time.
   */
  getOfferAtTime(
    t: Transaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    timestampUTC: number
  ): Promise<Offer | undefined>;

  /**
   * Returns all offers that have changed between oldTimestampUTC and
   * newTimestampUTC as OfferVersionPairs. And OfferVersionPair contains the
   * (possibly undefined) old version of the offer and the (possibly undefined)
   * new version of the offer.
   * Implementors are encouraged to implement this as a bulk operation in the
   * underlying storage system. However, if this is not possible, this method
   * can be implemented by calling getOffersAtTime() twice and comparing the
   * results from the two calls.
   */
  getChangedOffers(
    t: Transaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    oldTimestampUTC: number,
    newTimestampUTC: number,
    skipCount?: number
  ): AsyncIterable<OfferVersionPair>;

  /**
   * Records that an offer has been accepted. Note that this can be implemented
   * as a blind write, with no checking that the offer actually exists. Because
   * this is a blind write, the particular version of the offer being accepted
   * must be specified through a combination of the hostOrgUrl, offerId and
   * offerUpdateTimestampUTC parameters.
   */
  writeAccept(
    t: Transaction,
    hostOrgUrl: string,
    acceptingOrgUrl: string,
    offerId: string,
    offerUpdateTimestampUTC: number,
    atTimeUTC: number,
    decodedReshareChain?: DecodedReshareChain
  ): Promise<void>;

  /**
   * Records that an offer has been rejected. Note that this can be implemented
   * as a blind write, with no checking that the offer actually exists.
   */
  writeReject(
    t: Transaction,
    hostOrgUrl: string,
    rejectingOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    atTimeUTC: number
  ): Promise<void>;

  /** Returns a list of all organizations that have rejected an offer. */
  getAllRejections(
    t: Transaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string
  ): Promise<Array<string>>;

  /**
   * Returns a list of all accepted offers visible to the given organization. If
   * the sinceTimestampUTC parameter is specified, only offers accepted since
   * the given date will be returned.
   */
  getHistory(
    t: Transaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    sinceTimestampUTC?: number,
    skipCount?: number
  ): AsyncIterable<OfferHistory>;

  /**
   * Returns a list of all organizations that have been seen in the offeredBy
   * field of some offer. If the sinceTimestampUTC parameter is specified, only
   * organizations that have been seen since that timestamp will be returned.
   */
  getKnownOfferingOrgs(
    t: Transaction,
    hostOrgUrl: string,
    sinceTimestampUTC?: number
  ): AsyncIterable<string>;

  writeOfferProducerMetadata(
    t: Transaction,
    metadata: OfferProducerMetadata
  ): Promise<void>;

  getOfferProducerMetadata(
    t: Transaction,
    orgUrl: string
  ): Promise<OfferProducerMetadata | undefined>;

  /**
   * Performs any necessary initialization before the storage system is used.
   */
  initialize(): Promise<void>;

  /**
   * Performs any necessary cleanup operations before the storage system is
   * shut down (on server shutdown). Note that this method is not guaranteed
   * to be called if the server terminates unexpectedly.
   */
  shutdown(): Promise<void>;
}

export interface OfferVersionPair {
  oldVersion?: Offer;
  newVersion?: Offer;
}
