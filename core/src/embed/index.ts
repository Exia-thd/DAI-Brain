import type { CoreConfig } from '../config.js';
import { HashEmbeddingProvider } from './hash-provider.js';
import { TransformersEmbeddingProvider } from './transformers-provider.js';
import type { EmbeddingProvider } from './types.js';

export * from './types.js';
export { HashEmbeddingProvider } from './hash-provider.js';
export { TransformersEmbeddingProvider } from './transformers-provider.js';

export function createEmbeddingProvider(config: CoreConfig): EmbeddingProvider {
  if (config.embeddingProvider === 'transformers') {
    return new TransformersEmbeddingProvider(config.embeddingModel, config.embeddingDims);
  }
  return new HashEmbeddingProvider(config.embeddingDims, config.embeddingModel);
}
