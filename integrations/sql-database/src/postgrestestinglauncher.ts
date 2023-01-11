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

import * as fs from 'fs';
import * as path from 'path';
import process from 'node:process';
import {ChildProcessWithoutNullStreams, execSync, spawn} from 'child_process';
import net from 'net';
import os from 'os';
import {getFreePort, log, Logger} from 'opr-core';

/** A launcher for a local, empty instance of Postgres for testing. */
export interface PostgresTestingLauncherOptions {
  postgresBinaryPath?: string;
  postgresInitDbPath?: string;
  postgresPsqlPath?: string;
  dbPath?: string;
  postgresPort?: number;
  dbName?: string;
  logger?: Logger;
}

export class PostgresTestingLauncher {
  private readonly postgresBinaryPath?: string;
  private readonly postgresInitDbPath?: string;
  private readonly postgresPsqlPath?: string;
  private readonly requestedPostgresPort?: number;
  private readonly dbPath: string;
  private readonly dbName: string;
  private isShutDown = false;
  private isShuttingDown = false;
  private postgresProcess?: ChildProcessWithoutNullStreams;
  private postgresActivePort?: number;
  private stdoutData: Array<string>;
  private stderrData: Array<string>;
  private logger: Logger;

  constructor(options: PostgresTestingLauncherOptions = {}) {
    this.logger = options.logger ?? log.getLogger('PostgresTestingLauncher');
    this.postgresBinaryPath = options.postgresBinaryPath ?? this.findPostgres();
    this.postgresInitDbPath =
      options.postgresInitDbPath ??
      (this.postgresBinaryPath
        ? path.resolve(path.dirname(this.postgresBinaryPath), 'initdb')
        : undefined);
    this.postgresPsqlPath =
      options.postgresPsqlPath ??
      (this.postgresBinaryPath
        ? path.resolve(path.dirname(this.postgresBinaryPath), 'psql')
        : undefined);
    this.dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pg.db.temp'));
    this.dbName = options.dbName ?? 'oprtest';
  }

  private findPostgres(): string | undefined {
    try {
      return execSync('which postgres', {
        encoding: 'utf-8',
      }).trim();
    } catch (e) {
      this.logger.error(e);
      return undefined;
    }
  }

  getPort(): number | undefined {
    return this.postgresActivePort;
  }

  isPostgresAvailable() {
    if (
      !this.postgresBinaryPath ||
      !this.postgresInitDbPath ||
      !this.postgresPsqlPath
    ) {
      return false;
    }
    try {
      fs.accessSync(this.postgresPsqlPath, fs.constants.X_OK);
      fs.accessSync(this.postgresBinaryPath, fs.constants.X_OK);
      fs.accessSync(this.postgresInitDbPath, fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  private async startPostgres(): Promise<void> {
    const port = this.requestedPostgresPort ?? (await getFreePort());
    const postgresProcess = spawn(this.postgresBinaryPath!, [
      '-D',
      this.dbPath,
      '-p',
      `${port}`,
      '-k',
      '',
    ]);
    this.postgresProcess = postgresProcess;
    this.stdoutData = [];
    this.stderrData = [];
    postgresProcess.stdout.on('data', data => {
      this.stdoutData.push(data);
    });
    postgresProcess.stderr.on('data', data => {
      this.stderrData.push(data);
    });
    return new Promise(acceptFn => {
      const dataListener = (data: string) => {
        if (
          this.getStderrLog().indexOf(
            'database system is ready to accept connections'
          ) >= 0
        ) {
          postgresProcess.stderr.removeListener('data', dataListener);
          execSync(
            `${this.postgresPsqlPath!} ` +
              `-p ${port} -h localhost -d postgres ` +
              `-c "CREATE DATABASE ${this.dbName}"`
          );
          this.postgresActivePort = port;
          acceptFn();
        }
      };
      postgresProcess.stderr.on('data', dataListener);
    });
  }

  getStdoutLog(): string {
    return this.stdoutData.join('');
  }

  getStderrLog(): string {
    return this.stderrData.join('');
  }

  private async initDb(): Promise<void> {
    execSync(`${this.postgresInitDbPath} -D ${this.dbPath} -A trust`, {
      stdio: 'ignore',
    });
  }

  async start(): Promise<void> {
    if (!this.isPostgresAvailable()) {
      throw new Error('Postgres is not runnable from provided paths');
    }

    await this.initDb();
    await this.startPostgres();
    this.logger.info(
      'Postgres started at PID',
      this.postgresProcess?.pid,
      ', port',
      this.getPort(),
      ', data at ' + this.dbPath
    );
    process.on('exit', () => {
      this.shutdown();
    });
  }

  shutdown() {
    if (this.isShutDown || this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    if (this.postgresProcess) {
      this.postgresProcess?.kill(9);
    }
    fs.rmSync(this.dbPath, {
      recursive: true,
      force: true,
    });
    this.postgresProcess = undefined;
    this.postgresActivePort = undefined;

    // Do the shutdown
    this.isShutDown = true;
  }
}
