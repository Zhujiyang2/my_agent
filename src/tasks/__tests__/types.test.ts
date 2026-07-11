// src/tasks/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import { filterProgressBars } from '../types';

describe('filterProgressBars', () => {
  // ── 进度条过滤 ──

  it('移除典型的 wget 进度条行', () => {
    const input = [
      '正在解析主机 example.com...',
      '已连接 example.com (1.2.3.4)',
      'HTTP 请求已发送，正在等待回应... 200 OK',
      '长度: 13456789012 (13G)',
      '保存中: "model.weights"',
      '',
      '     0K .......... .......... ..........  1%  1.2M 5s',
      ' 50000K .......... .......... .......... 45%  1.5M 3s',
      '100000K .......... .......... .......... 98%  1.3M 0s',
      '134567K .......... .......... .......... 100% 1.4M=8s',
      '',
      '2026-07-11 14:00:00 (1.4 MB/s) - "model.weights" 已保存 [13456789012/13456789012]',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('正在解析主机 example.com');
    expect(result).toContain('HTTP 请求已发送');
    expect(result).toContain('已保存');
    // 进度条行应该被移除
    expect(result).not.toContain('50000K');
    expect(result).not.toContain('45%');
    expect(result).not.toContain('1.2M 5s');
    // 但最后一行完成信息应该保留（不是进度条，是结果）
    expect(result).toContain('model.weights');
  });

  it('移除 pip install 进度条', () => {
    const input = [
      'Collecting torch>=2.0.0',
      '  Downloading torch-2.5.0-cp310-cp310-linux_x86_64.whl (800.5 MB)',
      '     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 800.5/800.5 MB 5.2 MB/s eta 0:00:00',
      'Installing collected packages: torch',
      'Successfully installed torch-2.5.0',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('Collecting torch');
    expect(result).toContain('Downloading torch');
    expect(result).toContain('Successfully installed torch-2.5.0');
    // 进度条 ━━ 行应该被移除
    expect(result).not.toContain('━━━');
    expect(result).not.toContain('eta 0:00:00');
  });

  it('移除 tqdm 风格的进度条', () => {
    const input = [
      'Processing files...',
      ' 98%|████████▊| 196/200 [00:05<00:00, 38.5it/s]',
      '100%|██████████| 200/200 [00:05<00:00, 39.2it/s]',
      'Done processing 200 files.',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('Processing files');
    expect(result).toContain('Done processing 200 files');
    expect(result).not.toContain('████');
    expect(result).not.toContain('38.5it/s');
  });

  it('移除 git clone 的进度行', () => {
    const input = [
      'Cloning into \'my-repo\'...',
      'remote: Enumerating objects: 1234, done.',
      'remote: Counting objects: 100% (1234/1234), done.',
      'remote: Compressing objects: 100% (567/567), done.',
      'Receiving objects:  45% (556/1234), 2.5 MiB | 1.2 MiB/s',
      'Receiving objects: 100% (1234/1234), 5.6 MiB | 2.8 MiB/s, done.',
      'Resolving deltas: 100% (789/789), done.',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('Cloning into');
    expect(result).toContain('remote: Enumerating objects');
    // Receiving objects 45% 是进度条，移除
    expect(result).not.toContain('45%');
    // 但 100% done 行保留（非进度条，是完成信息）
    expect(result).toContain('Receiving objects: 100%');
    expect(result).toContain('done');
  });

  // ── 保留关键信息 ──

  it('保留错误信息和堆栈', () => {
    const input = [
      'Traceback (most recent call last):',
      '  File "train.py", line 42, in <module>',
      '    model = torch.load("model.pt")',
      'RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB',
    ].join('\n');

    const result = filterProgressBars(input);

    // 全部保留
    expect(result).toContain('Traceback');
    expect(result).toContain('RuntimeError');
    expect(result).toContain('CUDA out of memory');
  });

  it('保留文件路径和 URL', () => {
    const input = [
      'Downloading from https://huggingface.co/models/llama-7b/resolve/main/model.safetensors',
      'Saving to /data/models/llama-7b/model.safetensors',
      '  Downloaded: /data/models/llama-7b/model.safetensors',
      'Verifying checksum: sha256:abc123def456',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('https://huggingface.co');
    expect(result).toContain('/data/models/llama-7b');
    expect(result).toContain('sha256:abc123def456');
  });

  it('保留警告信息', () => {
    const input = [
      'WARNING: The script pip is installed in \'/home/user/.local/bin\' which is not on PATH.',
      '  Consider adding this directory to PATH.',
      'WARNING: Running pip as the \'root\' user can result in broken permissions.',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('WARNING');
    expect(result).toContain('/home/user/.local/bin');
    expect(result).toContain('PATH');
  });

  // ── 边界条件 ──

  it('全进度条输出返回空字符串', () => {
    const input = [
      ' 0%|          | 0/100 [00:00<?, ?it/s]',
      '50%|█████     | 50/100 [00:02<00:02, 25.0it/s]',
      '100%|██████████| 100/100 [00:04<00:00, 25.0it/s]',
    ].join('\n');

    const result = filterProgressBars(input);

    // 全是进度条，过滤后应该只剩空（或只有空白行）
    expect(result.trim()).toBe('');
  });

  it('无进度条的输出原样保留', () => {
    const input = [
      'Hello, world!',
      'This is a normal output.',
      'Nothing to filter here.',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('Hello, world!');
    expect(result).toContain('This is a normal output');
    expect(result).toContain('Nothing to filter here');
  });

  it('连续空行折叠为单个空行', () => {
    const input = [
      'Line 1',
      '',
      '',
      '',
      'Line 2',
    ].join('\n');

    const result = filterProgressBars(input);

    // Line1 和 Line2 之间最多一个空行
    const lines = result.split('\n');
    const nonEmptyIndices = lines
      .map((line, i) => (line.trim() ? i : -1))
      .filter((i) => i !== -1);
    expect(nonEmptyIndices.length).toBe(2);
    // 检查 Line1 和 Line2 之间不超过 1 个空行
    expect(nonEmptyIndices[1] - nonEmptyIndices[0]).toBeLessThanOrEqual(2);
  });

  it('混合 \r 的进度行被移除', () => {
    const input = [
      'Processing...',
      '\rProgress: 50% complete',
      '\rProgress: 100% complete',
      'Done.',
    ].join('\n');

    const result = filterProgressBars(input);

    expect(result).toContain('Processing');
    expect(result).toContain('Done');
    expect(result).not.toContain('Progress: 50%');
    expect(result).not.toContain('Progress: 100%');
  });

  it('空输入返回空字符串', () => {
    const result = filterProgressBars('');
    expect(result).toBe('');
  });

  it('单行空白输入返回空字符串', () => {
    const result = filterProgressBars('   \n  \n  ');
    expect(result.trim()).toBe('');
  });
});
