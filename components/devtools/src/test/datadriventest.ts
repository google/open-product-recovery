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

import {expect} from 'chai';
import * as glob from 'glob';
import * as path from 'path';
import {Resolver, ResolverOptions} from '../json/resolver';
import {
  createArtificialLocation,
  JsonObject,
  parsePathSync,
  SourcedJsonArray,
  SourcedJsonObject,
  SourcedJsonValue,
} from '../json/sourcedjson';

/**
 * A test that is built and run from a JSON template. In this framework, a
 * data-driven test requires some minimal configuration code to build a test
 * object and apply JSON-specified operations to that test object. Then, JSON
 * files specify tests and test suites that specify operations to apply to a
 * test object, and expectations about how the test object should be changed
 * by those operations.
 *
 * A data driven test might look like this:
 *  {
 *    "description": "Getter test suite",
 *    "expectedValue": {
 *      "$import": "./expectedvalue.json"
 *    },
 *    "tests": [
 *      {
 *        "description" : "getValue returns successfully",
 *        "calls": [
 *         {
 *           "op": "getValue",
 *           "expect": "expect(result).to.equal(expectedValue)"
 *          }
 *        ]
 *      },
 *      {
 *        "description" : "getTimeout has correct default",
 *        "calls": [
 *          {
 *            "op": "getTimeout",
 *            "expectedValue" : 12,
 *            "expect": "expect(result).to.equal(expectedValue)"
 *          }
 *        ]
 *      }
 *    ]
 *  }
 *
 * A data-driven test contains one or more tests, optionally grouped into
 * suites. A "suite" is an object with a "description" field and a "tests"
 * field, containing a list of tests or suites. A "test" is an object with a
 * "description" field and a "calls" property containing a list of calls.
 *
 * TODO: Add an explanation of contexts, how they are scoped and override each
 * other, how new test objects are created and discarded, and how expectations
 * work.
 */
export class DataDrivenTest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private configs: Array<TestConfig<any>>;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configs: TestConfig<any> | TestConfig<any>[]
  ) {
    if (!Array.isArray(configs)) {
      configs = [configs];
    }
    if (configs.length === 0) {
      throw new Error('At least one test configuration must be specified.');
    }
    this.configs = configs;
  }

  /** Builds and then runs all JSON test files. */
  initialize(): void {
    this.configs.map(c => this.initializeConfig(c));
  }

  private initializeConfig<T>(config: TestConfig<T>): void {
    describe(config.name, () => {
      let found = false;
      if (config.beforeAllTests) {
        before(async () => await config.beforeAllTests!());
      }
      if (config.afterAllTests) {
        after(async () => await config.afterAllTests!());
      }
      for (const globPath of Array.isArray(config.pathGlob)
        ? config.pathGlob
        : [config.pathGlob]) {
        const paths = glob.sync(globPath ?? '**/*.test.json', {
          cwd: config.cwd,
        });
        for (const testPath of paths) {
          describe(testPath, () => {
            let initError: unknown | undefined;
            try {
              const testRoot: SourcedJsonValue = parsePathSync(
                path.resolve(config.cwd, testPath)
              );
              found = true;
              testRoot.assertIsObject(
                'The root value in a test file must be an object'
              );
              this.initializeSuiteOrTest(config, testRoot, testRoot);
            } catch (e) {
              initError = e;
            }
            it(`${testPath} should initialize`, () => {
              if (initError) {
                throw initError;
              }
            });
          });
        }
      }
      if (!found) {
        expect.fail('No tests found for config: ' + config.name);
      }
    });
  }

  private extractContext(
    obj: SourcedJsonObject,
    context = new SourcedJsonObject(
      createArtificialLocation('<generated test context>')
    ),
    fields = obj.getOwnKeys()
  ): SourcedJsonObject {
    for (const key of fields) {
      if (RESERVED_TEST_PROPERTIES.indexOf(key) >= 0) {
        continue;
      }
      const value = obj.getSourced(key);
      if (value) {
        context.setSourced(key, value);
      }
    }
    return context;
  }

  private mergeContexts(
    loser: SourcedJsonObject,
    winner: SourcedJsonObject
  ): SourcedJsonObject {
    const context = this.extractContext(loser);
    this.extractContext(winner, context);
    return context;
  }

  private assertNoDirectiveKeys<T>(
    config: TestConfig<T>,
    testOrSuite: SourcedJsonObject
  ) {
    const resolver = new Resolver(config.resolverOptions);
    for (const key of testOrSuite.getOwnKeys()) {
      if (resolver.isDirectiveKey(key)) {
        throw new Error(
          'Directives are not allowed at top level of tests and suites'
        );
      }
    }
  }

  private initializeSuiteOrTest<T>(
    config: TestConfig<T>,
    testRoot: SourcedJsonObject,
    sourcedJson: SourcedJsonValue,
    testPath: Array<number> = []
  ): void {
    sourcedJson.assertIsObject('A test must be an object');
    this.assertNoDirectiveKeys(config, sourcedJson);
    const description = sourcedJson.propAsString('description').req();
    const enabled = sourcedJson.propAsBoolean('enabled').getOrDefault(true);
    if (!enabled) {
      return;
    }
    const tests = sourcedJson.propAsArray('tests').getSourced();
    const calls = sourcedJson.propAsArray('calls').getSourced();
    if (tests !== undefined && calls !== undefined) {
      sourcedJson.fail(
        'Tests cannot define both a "tests" and "calls" property'
      );
    }

    if (tests) {
      describe(description, () => {
        for (let i = 0; i < tests.getLength(); i++) {
          const test = tests.propAsObject(i).reqSourced();
          this.initializeSuiteOrTest(config, testRoot, test, [...testPath, i]);
        }
      });
    } else if (calls) {
      this.initializeTest(config, description, testRoot, testPath);
    } else {
      sourcedJson.fail(
        'Test initializer must specify a "tests" or "calls" property'
      );
    }
  }

  private initializeTest<T>(
    config: TestConfig<T>,
    description: string,
    testRoot: SourcedJsonObject,
    testPath: Array<number>
  ): void {
    let testObject: T;
    let test: SourcedJsonObject;
    let context: SourcedJsonObject;
    before(async () => {
      const resolver = new Resolver(config.resolverOptions);
      const resolvedRoot: SourcedJsonValue = await resolver.resolve(testRoot);
      resolvedRoot.assertIsObject(
        'Bad test template: is no longer an object after template resolution'
      );
      test = resolvedRoot;
      context = this.extractContext(test);
      for (const index of testPath) {
        test = test
          .propAsArray('tests')
          .reqSourced()
          .propAsObject(index)
          .reqSourced();
        context = this.mergeContexts(context, test);
      }
    });
    beforeEach(async () => {
      testObject = await config.buildTestObject(context);
    });
    it(description, async () => {
      const calls: SourcedJsonArray = test.propAsArray('calls').reqSourced();
      for (const call of calls) {
        call.assertIsObject('Each test call must be an object');
        const newContext = this.extractContext(call);
        const callContext = this.mergeContexts(context, newContext);
        const expectErrorSourced = call.prop('expectError').getSourced();
        const expectResultsSourced = call.prop('expect').getSourced();
        if (expectErrorSourced && expectResultsSourced) {
          call.fail('Cannot specify both expect and expectError properties');
        }

        let result: Record<string, unknown> | undefined;
        let error;
        try {
          result = await config.applyOperation(testObject, callContext);
        } catch (e) {
          if (!expectErrorSourced) {
            call.fail('Unexpected error applying operation', e);
          }
          error = e;
        }
        if (expectErrorSourced) {
          expect(result, 'Expected error, but got result').to.be.undefined;
          expect(error, 'Expected error').to.be.not.undefined;
          const expectErrors: Array<SourcedJsonValue> =
            expectErrorSourced.isArray()
              ? [...expectErrorSourced]
              : [expectErrorSourced];
          for (const expectation of expectErrors) {
            expectation.assertIsString('Expectations must be strings');
            const expectationValueMap = {
              ...callContext.toJson(),
              error: error,
            } as Record<string, unknown>;

            const resultKeys = Object.getOwnPropertyNames(expectationValueMap);
            const checkerFn = new Function(
              ...resultKeys,
              'expect',
              expectation.value
            );
            try {
              checkerFn(
                ...resultKeys.map(key => expectationValueMap[key]),
                expect
              );
            } catch (e) {
              if (e instanceof Error) {
                expectation.fail(e.message);
              } else {
                expectation.fail(String(e));
              }
            }
          }
        } else if (expectResultsSourced) {
          expect(result, 'Expected results').to.be.not.undefined;
          const expectResults: Array<SourcedJsonValue> =
            expectResultsSourced.isArray()
              ? [...expectResultsSourced]
              : [expectResultsSourced];
          for (const expectation of expectResults) {
            expectation.assertIsString('Expectations must be strings');
            const expectationValueMap = {
              ...callContext.toJson(),
              ...result,
            };

            const resultKeys = Object.getOwnPropertyNames(expectationValueMap);
            const checkerFn = new Function(
              ...resultKeys,
              'expect',
              expectation.value
            );
            try {
              checkerFn(
                ...resultKeys.map(key => expectationValueMap[key]),
                expect
              );
            } catch (e) {
              if (e instanceof Error) {
                expectation.fail(e.message, e);
              } else {
                expectation.fail(String(e));
              }
            }
          }
        }
      }
    });
    afterEach(async () => {
      config.teardownTestObject &&
        (await config.teardownTestObject(testObject));
    });
  }
}

/**
 * A test configuration. At least one test configuration must be specified for
 * a data driven test.
 */
export interface TestConfig<TestObjectType> {
  /**
   * The current working directory of this test config. This value is used to
   * resolve relative path globs to find JSON tests.
   */
  readonly cwd: string;
  /**
   * The name of this test config.
   */
  readonly name: string;

  /**
   * One or more path globs to use to find tests for this configuration. If not
   * specified, defaults to "** / *.test.json"
   */
  readonly pathGlob?: string | Array<string>;

  /**
   * Sets options for the template resolver. This is useful for installing
   * custom template directives.
   */
  readonly resolverOptions?: ResolverOptions;

  /**
   * Builds a test object from the context of the current test. Often, the
   * "test object" is a wrapper object that collects the primary object under
   * test, as well as whatever ancillary objects, fakes and mocks are necessary
   * to manipulate that object during testing.
   */
  buildTestObject(context: SourcedJsonObject): Promise<TestObjectType>;

  /**
   * Applies some operation to the test object using the current test context.
   * The operation returns a map of key/value pairs. The keys are available as
   * variables in any expect properties specified in a call.
   */
  applyOperation(
    testObject: TestObjectType,
    context: SourcedJsonObject
  ): Promise<Record<string, unknown>>;

  teardownTestObject?: (testObject: TestObjectType) => Promise<void>;

  beforeAllTests?: () => Promise<void>;
  afterAllTests?: () => Promise<void>;
}

const RESERVED_TEST_PROPERTIES = [
  'description',
  'comment',
  'enabled',
  'tests',
  'calls',
  'expectError',
  'expect',
] as Readonly<Array<string>>;
