import { describe, expect, it } from 'vitest';
import { isDockerMetadataQuery } from './docker-query-policy.js';

describe('bounded Docker formatter grammar', () => {
  it.each(['{{.ID}}', '{{.Repository}}:{{.Tag}}', 'table {{.Names}} | {{.Image}}',
    '镜像 {{.Repository}}:{{.Tag}} / 大小 {{.Size}}', '{{.ID}}\\t{{.Size}}', '{{.ID}}\t{{.Size}}'])('permits fields with literal labels: %s', (format) => {
    expect(isDockerMetadataQuery(['images', '--format', format])).toBe(true);
    expect(isDockerMetadataQuery(['images', `--format=${format}`])).toBe(true);
  });

  it.each(['', 'json', '{{json .}}', '{{.ID | printf}}', '{{if .ID}}{{.ID}}{{end}}',
    '{{.ID}}{', '{{.ID}}\\n', '{{.ID}}\n', '{{.ID}}\r', '{{.ID}}\u001b[31m',
    '{{.ID}}\u0000', '{{.ID}}' + 'a'.repeat(4096)])('rejects template programs, controls or oversized formats', (format) => {
    expect(isDockerMetadataQuery(['images', '--format', format])).toBe(false);
  });

  it.each([
    ['images', '--filter', 'dangling=true'], // Not attested by this deliberately bounded grammar yet.
    ['images', '--format', '{{.ID}}', '--format', '{{.Size}}'],
    ['images', '--host', 'tcp://other'], ['image', 'prune'], ['image', 'rm', 'old'],
    ['network', 'ls', '--size'], ['network', 'ls', '--all'], ['ps', '--digests'], ['images', '--size']
  ])('does not confuse arbitrary Docker arguments with listing options: %j', (...args) => {
    expect(isDockerMetadataQuery(args)).toBe(false);
  });
});
