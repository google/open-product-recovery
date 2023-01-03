# Open Product Recovery

This is the monorepo for the reference implementation of the Open Product
Recovery standards. Open Product Recovery is a collection of standards and
implementations designed to facilitate sharing of excess products with
charitable (and secondary market) organizations.

## What is Open Product Recovery (OPR)?

Open Product Recovery is a specification for describing and communicating
about excess food (and other donatable products). OPR servers can publish offers
of donatable products to other OPR servers, and every OPR server hosts a public
REST API to allow other organizations to accept those offers.

## Is OPR useful for my organization?

Yes! If:

1. Your organization generates enough donatable products that you need a way to
   automatically tell charitable organizations that you have donations for them.
2. Or, your charitable organization needs to receive enough donatable products
   that you need a way to automatically discover donations.

Ideally, your organization already has an inventory system that tracks the
donations you work with. OPR has a flexible plugin system that allows it to
read and write offers to and from just about any storage system with an API.

## What is in this repository?

This repository contains a number of nodejs projects that work together to
implement the OPR specification. Please read the README file in each of the
subdirectories to find out more about the libraries in each component.

## How do I get started?

### Install deps and build

First, run lerna bootstrap to install all package dependencies and compile local libraries in the correct order.

```console
npx lerna bootstrap --hoist
```

The --hoist flag is optional for local builds, but the --hoist flag is _required_ for library development. Hoisting creates a very different package-lock structure from non-hoisted repositories. We standardize on the hoisted versions in the repository to avoid churn.

### Run the unit tests

Run

```console
npx lerna run test
```

from the root directory to run all the unit tests. If you want to run the Postgres tests in opr-sql-database, you need to have a working installation of Postgres and the `initdb`, `postgres` and `psql` commands must be in your `PATH` environment variable. If those commands aren't available, the Postgres tests will be skipped.

### Read the standards

This library is the reference implementation for [the Open Product Recovery standards](standards/README.md). You may want to read the standards docs before you dive into setting up your own server.

### Start configuring your own OPR server

Check out the `examples` folder for example working setups for various environments. A good place to start is the `local-starter` folder. The local starter example uses an sqlite database and includes some special endpoints to help generate fake offers so that its easier to see common settings for a server and how they work.

### Version Warning

The Current Version of OPR is in beta and the major version is 0. All changes to the library may by breaking changes. Please refer to the discussions for details on updates. (https://github.com/google/open-product-recovery/discussions)
