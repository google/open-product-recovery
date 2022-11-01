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

/* eslint-disable @typescript-eslint/no-unused-vars */
import {ReshareChain} from 'opr-models';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  JoinColumn,
  ManyToOne,
  Index,
  AfterLoad,
} from 'typeorm';
import {OfferSnapshot} from './offersnapshot';

@Entity()
export class StoredTimelineEntry {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  hostOrgUrl: string;

  @Column()
  @Index()
  targetOrganizationUrl: string;

  @Column({default: false})
  @Index()
  isReservation: boolean;

  @Column({type: 'bigint'})
  @Index()
  startTimeUTC: number;

  @Column({type: 'bigint'})
  @Index()
  endTimeUTC: number;

  @Column({type: 'simple-json', nullable: true})
  reshareChain?: ReshareChain;

  // The snapshot column is a synthetic column used to represent the
  // join to the snapshot table. Sometimes we want to fetch the snapshot
  // ids without loading the whole snapshot, so we define the three implied
  // id columns explicitly so they're available from the entity manager.
  @ManyToOne(() => OfferSnapshot)
  @JoinColumn()
  snapshot: OfferSnapshot;

  @Column()
  snapshotOfferId: string;

  @Column()
  snapshotPostingOrgUrl: string;

  @Column({type: 'bigint'})
  snapshotLastUpdateUTC: number;

  @AfterLoad()
  restoreBigInt() {
    // Bigints are marshalled to strings in some drivers, and are not
    // unmarshalled for fear of precision loss. We can safely unmarshal them,
    // because we know these are timestamps.
    if (typeof this.startTimeUTC === 'string') {
      this.startTimeUTC = parseInt(this.startTimeUTC);
    }

    if (typeof this.endTimeUTC === 'string') {
      this.endTimeUTC = parseInt(this.endTimeUTC);
    }

    if (typeof this.snapshotLastUpdateUTC === 'string') {
      this.snapshotLastUpdateUTC = parseInt(this.snapshotLastUpdateUTC);
    }
  }
}
