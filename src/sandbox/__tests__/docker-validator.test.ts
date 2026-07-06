// src/sandbox/__tests__/docker-validator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { isDockerCommand, parseVolumeMounts, createDockerValidator } from '../docker-validator';
import { createPathPolicy } from '../path-policy';

describe('isDockerCommand', () => {
  it('detects docker run', () => {
    expect(isDockerCommand('docker run hello-world')).toBe(true);
    expect(isDockerCommand('  docker run hello-world')).toBe(true);
  });

  it('detects docker create', () => {
    expect(isDockerCommand('docker create --name test ubuntu')).toBe(true);
  });

  it('returns false for non-docker commands', () => {
    expect(isDockerCommand('echo hello')).toBe(false);
    expect(isDockerCommand('ls -la')).toBe(false);
  });

  it('returns false for docker-like but not docker commands', () => {
    expect(isDockerCommand('dockerrun')).toBe(false);
    expect(isDockerCommand('adocker run')).toBe(false);
  });
});

describe('parseVolumeMounts', () => {
  it('parses -v host:container', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /data:/data ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ hostPath: '/data', containerPath: '/data' });
  });

  it('parses -v host:container:ro', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /data:/data:ro ubuntu'
    );
    expect(mounts[0].mode).toBe('ro');
  });

  it('parses --mount type=bind,source=/src,target=/dst', () => {
    const mounts = parseVolumeMounts(
      'docker run --mount type=bind,source=/src,target=/dst ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0].hostPath).toBe('/src');
    expect(mounts[0].containerPath).toBe('/dst');
  });

  it('parses --mount with readonly option', () => {
    const mounts = parseVolumeMounts(
      'docker run --mount type=bind,source=/src,target=/dst,readonly ubuntu'
    );
    expect(mounts[0].mode).toBe('ro');
  });

  it('parses --volume (long form)', () => {
    const mounts = parseVolumeMounts(
      'docker run --volume /data:/data:ro ubuntu'
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0].hostPath).toBe('/data');
  });

  it('parses multiple -v flags', () => {
    const mounts = parseVolumeMounts(
      'docker run -v /a:/a -v /b:/b:ro -v /c:/c ubuntu'
    );
    expect(mounts).toHaveLength(3);
  });

  it('returns empty array when no volume mounts', () => {
    const mounts = parseVolumeMounts('docker run ubuntu echo hello');
    expect(mounts).toHaveLength(0);
  });
});

describe('createDockerValidator', () => {
  let policy: ReturnType<typeof createPathPolicy>;
  let validator: ReturnType<typeof createDockerValidator>;

  beforeEach(() => {
    policy = createPathPolicy();
    policy.registerWritable('/mnt/workspace');
    validator = createDockerValidator(policy);
  });

  it('allows writable paths in -v', () => {
    const result = validator.validate('docker run -v /mnt/workspace/models:/models ubuntu');
    expect(result.ok).toBe(true);
    expect(result.blocked).toHaveLength(0);
  });

  it('allows /etc paths (system read-only, safe)', () => {
    const result = validator.validate('docker run -v /etc/localtime:/etc/localtime:ro ubuntu');
    expect(result.ok).toBe(true);
  });

  it('blocks protect paths', () => {
    const result = validator.validate(
      'docker run -v /etc/shadow:/shadow ubuntu'
    );
    expect(result.ok).toBe(false);
    expect(result.blocked.length).toBeGreaterThan(0);
  });

  it('blocks / (entire host bind mount)', () => {
    const result = validator.validate('docker run -v /:/host ubuntu');
    expect(result.ok).toBe(false);
  });

  it('blocks unregistered paths', () => {
    const result = validator.validate(
      'docker run -v /some/unknown/path:/data ubuntu'
    );
    expect(result.ok).toBe(false);
  });

  it('returns ok:true for docker commands with no volume mounts', () => {
    const result = validator.validate('docker run ubuntu echo hello');
    expect(result.ok).toBe(true);
  });

  it('reports reason for each blocked path', () => {
    const result = validator.validate(
      'docker run -v /bad/path:/data -v /another/bad:/more ubuntu'
    );
    expect(result.ok).toBe(false);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked[0].reason).toBeTruthy();
  });
});
