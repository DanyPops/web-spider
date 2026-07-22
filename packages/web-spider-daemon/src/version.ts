/**
 * Runtime package version; package.json is the single release source of
 * truth. Delegates to @danypops/daemon-kit's readPackageVersion, which this
 * daemon's own hand-rolled version (fixed earlier this session after it had
 * drifted into a stale hardcoded "0.1.0") now shares with jittor/papyrus/
 * pi-packed's identical implementations.
 */
import { readPackageVersion } from "@danypops/daemon-kit/version";

export const VERSION = readPackageVersion(new URL("../package.json", import.meta.url), "Web Spider daemon");
