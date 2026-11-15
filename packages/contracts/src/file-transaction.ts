export interface FileRecoveryView {
  version: 1; directoryId: string; path: string;
  beforeSha256: string; beforeMetadataDigest: string; afterSha256: string; afterMetadataDigest: string;
}
