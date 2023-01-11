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
  DecodedReshareChain,
  HistoryPayload,
  HistoryResponse,
  ListOffersPayload,
  ListOffersResponse,
  Offer,
  RejectOfferResponse,
  ReserveOfferResponse,
} from 'opr-models';
import {OfferSetUpdate} from '../offerproducer/offerproducer';
import {OfferProducerMetadata} from '../offerproducer/offerproducermetadata';
import {HandlerRegistration} from './handlerregistration';
import {OfferChange} from './offerchange';

/**
 * An OPR server's mutable datamodel, containing all the methods needed to
 * maintain a collection of offers from multiple offer producers.
 */
export interface OfferModel {
  initialize(): Promise<void>;

  shutdown(): Promise<void>;

  writeOfferProducerMetadata(metadata: OfferProducerMetadata): Promise<void>;

  getOfferProducerMetadata(
    producerId: string
  ): Promise<OfferProducerMetadata | undefined>;

  list(orgUrl: string, payload: ListOffersPayload): Promise<ListOffersResponse>;

  processUpdate(fromOrgUrl: string, update: OfferSetUpdate): Promise<void>;

  accept(
    offerId: string,
    orgUrl: string,
    ifNotNewerThanTimestampUTC?: number,
    decodedReshareChain?: DecodedReshareChain
  ): Promise<AcceptOfferResponse>;

  reject(
    rejectingOrgUrl: string,
    offerId: string,
    postingOrgUrl?: string
  ): Promise<RejectOfferResponse>;

  reserve(
    offerId: string,
    requestedReservationSecs: number,
    orgUrl: string
  ): Promise<ReserveOfferResponse>;

  getHistory(orgUrl: string, payload: HistoryPayload): Promise<HistoryResponse>;

  registerChangeHandler(
    handlerFn: (change: OfferChange) => Promise<void>
  ): HandlerRegistration;

  getAllOffers(): Promise<Array<Offer>>;
}
