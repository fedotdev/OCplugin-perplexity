/**
 * opencode-plugin-perplexity
 *
 * Registers a single tool `perplexity_research` that queries Perplexity
 * through the OpenCLI Browser Bridge adapter (`opencli perplexity ask`).
 *
 * Security model:
 *  - The tool accepts only a question string, allowedDomains, and numeric
 *    flags — no arbitrary shell commands, no URLs, no credentials.
 *  - All output is tagged as untrusted data.
 *  - Auth lives entirely in the Chrome profile managed by OpenCLI.
 */
import type { Plugin } from "@opencode-ai/plugin";
export declare const plugin: Plugin;
