import type { TranscribeOptions } from "../../src/lib";

// @ts-expect-error `silent` is not a Core API option.
const options: TranscribeOptions = { silent: false };

void options;
