import { describe, expect, it } from 'vitest';
import { decideSafety, isEffectFreeQuery, isReadOnlyQuery, type ProposedOperation } from '@cloudhelm/core';
import { BashAnalyzer } from './bash-analyzer.js';

const analyzer = new BashAnalyzer();
const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: '列出镜像及用途' };

const queries = [
  'docker images', 'docker image ls', 'docker images -a --digests --no-trunc -q',
  'docker ps -a --size', 'docker container ls --all', 'docker network ls --no-trunc', 'docker version',
  "docker images --format '{{.Repository}}:{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}'",
  "sudo docker images --format '{{.Repository}}:{{.Tag}} | {{.ID}} | {{.Size}} | {{.CreatedSince}}'",
  "sudo docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'",
  'docker ps --format "{{.Names}} {{.Image}}"',
  'docker images --format="{{.Repository}}:{{.Tag}} | {{.Size}}"',
  "docker image ls --format='table {{.Repository}}:{{.Tag}} | {{.Size}}'",
  'sudo docker ps --format="{{.Names}}\\t{{.Image}}"',
  "docker images --format '{{.Repository}}\t{{.Tag}}'",
  '/usr/bin/docker images', 'sudo /usr/bin/docker image ls'
];
const nonQueries = [
  'docker image rm alpine', 'docker image prune', 'docker images --size', 'docker network ls --all',
  'docker ps --digests', 'docker images --format', 'docker images --format=',
  "docker images --format '{{json .}}'", "docker images --format '{{.Repository | printf}}'",
  "docker images --format '{{range .}}{{end}}'", "docker images --format '{{.ID}'",
  'docker --context other images', 'docker -H tcp://other images', 'docker images --host=tcp://other',
  'DOCKER_HOST=tcp://other docker images', 'env DOCKER_HOST=tcp://other docker images',
  'docker images > /tmp/images', 'docker images | tee /tmp/images', 'docker images; touch /tmp/change',
  'docker images &', 'docker images && docker image rm old',
  'docker images --format="{{.ID}}$(touch /tmp/change)"',
  'docker images --format="{{.ID}}$FORMAT"', 'docker images --format="{{.ID}}"$FORMAT',
  'docker images --format="{{.ID}}`touch /tmp/change`"',
  'sudo -E docker images', 'sudo -u root docker images', 'sudo sh -c "docker images"',
  '/tmp/docker images'
];

describe('Docker metadata query capability', () => {
  it.each(queries)('recognizes a literal metadata query: %s', async (command) => {
    const analysis = await analyzer.analyze(command);
    expect(analysis.hasPipeline).toBe(false);
    expect(isReadOnlyQuery(analysis)).toBe(true);
    expect(isEffectFreeQuery(analysis)).toBe(true);
    const operation: ProposedOperation = { id: 'operation', kind: 'command', command, scope };
    for (const mode of ['ask', 'ai-review', 'permissive'] as const) {
      expect(decideSafety(operation, { mode, revision: 1 }, analysis)).toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
    }
  });

  it.each(nonQueries)('does not mint a capability for unsupported or mutating syntax: %s', async (command) => {
    const analysis = await analyzer.analyze(command);
    expect(isReadOnlyQuery(analysis)).toBe(false);
    expect(isEffectFreeQuery(analysis)).toBe(false);
  });

  it('keeps policy freshness independent of a read-only capability', async () => {
    const command = 'docker images';
    const analysis = await analyzer.analyze(command);
    expect(decideSafety({ id: 'operation', kind: 'command', command, scope }, { mode: 'permissive', revision: 2 }, analysis))
      .toMatchObject({ verdict: 'error', ruleId: 'policy-stale' });
  });

  it('does not auto-approve literal multi-query lists just because they are effect-free', async () => {
    const analysis = await analyzer.analyze('docker images; docker ps');
    expect(isEffectFreeQuery(analysis)).toBe(true);
    expect(isReadOnlyQuery(analysis)).toBe(false);
  });
});
