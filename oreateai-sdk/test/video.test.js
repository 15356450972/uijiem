import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVideoCapabilities,
  createSseParser,
  createUploadParts,
  extractHistoryVideoResult,
  extractVideoResult,
  inspectHistoryVideoOutcome,
} from '../src/video.js';

const modelsPayload = {
  data: {
    models: [
      {
        modelName: 'Seedance 2.0 Mini',
        description: { zh: 'Mini' },
        supportAudio: true,
        supportModifySize: true,
        videoSize: [{ ratio: '1:1' }, { ratio: '16:9' }],
        pointCostImage: [
          { audio: false, duration: 5, resolution: '480', point: 20, aiType: 14198 },
          { audio: true, duration: 5, resolution: '480', point: 20, aiType: 14199 },
        ],
        pointCostReference: [
          { duration: 5, refDuration: '2-5', resolution: '480', point: 20, aiType: 14206 },
          { duration: 5, refDuration: '6-10', resolution: '480', point: 30, aiType: 14207 },
        ],
      },
      {
        modelName: 'Seedance 2.0',
        description: { zh: '旗舰' },
        supportAudio: true,
        supportModifySize: true,
        videoSize: [{ ratio: '1:1' }],
        pointCostImage: [{ audio: false, duration: 10, resolution: '1080', point: 455, aiType: 14090 }],
        pointCostReference: [{ duration: 10, refDuration: '11-15', resolution: '1080', point: 1000, aiType: 14109 }],
      },
      {
        modelName: 'Seedance 2.0 Fast',
        description: { zh: 'Fast' },
        supportAudio: true,
        supportModifySize: true,
        videoSize: [{ ratio: '16:9' }],
        pointCostImage: [{ audio: true, duration: 10, resolution: '720', point: 145, aiType: 14079 }],
        pointCostReference: [{ duration: 10, refDuration: '2-5', resolution: '720', point: 140, aiType: 14119 }],
      },
      { modelName: 'Other', pointCostImage: [{ aiType: 1 }] },
    ],
  },
};

const scenesPayload = {
  data: {
    scenes: [
      {
        sceneId: 'text_or_image',
        sceneName: { zh: '文/图生视频' },
        factory: [{ models: [
          { modelName: 'Seedance 2.0 Mini', restrictions: '' },
          { modelName: 'Seedance 2.0', restrictions: '' },
          { modelName: 'Seedance 2.0 Fast', restrictions: '' },
        ] }],
      },
      {
        sceneId: 'reference',
        sceneName: { zh: '参考生视频' },
        factory: [{ models: [
          { modelName: 'Seedance 2.0 Mini', restrictions: '{"inputSlots":{"video":{"min":0,"max":3,"totalDurationSecMin":2,"totalDurationSecMax":15},"image":{"min":0,"max":9}}}' },
          { modelName: 'Seedance 2.0', restrictions: '{}' },
          { modelName: 'Seedance 2.0 Fast', restrictions: '{}' },
        ] }],
      },
      { sceneId: 'motion', factory: [{ models: [{ modelName: 'Seedance 2.0 Mini' }] }] },
    ],
  },
};

test('buildVideoCapabilities keeps only the three supported Seedance models and real scenes', () => {
  const result = buildVideoCapabilities(modelsPayload, scenesPayload);
  assert.deepEqual(result.models, ['Seedance 2.0 Mini', 'Seedance 2.0', 'Seedance 2.0 Fast']);
  assert.deepEqual(result.scenes.map((item) => item.id), ['text_or_image', 'reference']);
  assert.equal(result.capabilities.length, 6);
  const miniReference = result.capabilities.find((item) => item.modelName === 'Seedance 2.0 Mini' && item.scene === 'reference');
  assert.equal(miniReference.combinations[0].aiType, 14206);
  assert.equal(miniReference.restrictions.inputSlots.video.totalDurationSecMax, 15);
});

test('createUploadParts uses exact 5 MiB sequential ranges', () => {
  const chunk = 5 * 1024 * 1024;
  assert.deepEqual(createUploadParts(chunk - 1), [{ start: 0, stop: chunk - 2, totalSize: chunk - 1 }]);
  assert.deepEqual(createUploadParts(chunk), [{ start: 0, stop: chunk - 1, totalSize: chunk }]);
  assert.deepEqual(createUploadParts(chunk + 1), [
    { start: 0, stop: chunk - 1, totalSize: chunk + 1 },
    { start: chunk, stop: chunk, totalSize: chunk + 1 },
  ]);
});

test('SSE parser preserves chunk boundaries and emits formal events', () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  parser.push('data: {"event":"start","data":{}}\n\ndata: {"event":"gener');
  parser.push('ating","data":{"result":"{\\"metadata\\":{\\"files\\":[]}}"}}\n\n');
  parser.end();
  assert.deepEqual(events.map((event) => event.event), ['start', 'generating']);
});

test('extractVideoResult only accepts metadata.files aiVideo entries', () => {
  const result = extractVideoResult({
    event: 'generating',
    data: {
      result: JSON.stringify({
        metadata: {
          files: [
            { file_type_ext: 'image', url: 'https://cdn.example/image.png' },
            { file_type_ext: 'aiVideo', url: 'https://cdn.oreateai.com/aivideo/videodownload/1.mp4' },
          ],
        },
      }),
    },
  });
  assert.equal(result.url, 'https://cdn.oreateai.com/aivideo/videodownload/1.mp4');
  assert.throws(() => extractVideoResult({ data: { result: '{"metadata":{"files":[]}}' } }), /没有有效 aiVideo/);
});

test('extractHistoryVideoResult accepts only verified assistant video messages', () => {
  const result = extractHistoryVideoResult({
    data: {
      messageList: [
        { role: 'user', type: 8, content: 'ignored' },
        {
          role: 'assistant',
          type: 9,
          messageID: 'message-1',
          content: '<video controlslist="nodownload" src="https://cdn.oreateai.com/aivideo/videodownload/2543472111.mp4"></video>',
        },
      ],
    },
  });
  assert.equal(result.url, 'https://cdn.oreateai.com/aivideo/videodownload/2543472111.mp4');
  assert.equal(result.file.file_type_ext, 'aiVideo');
  assert.equal(result.metadata.source, 'history-message');
});

test('inspectHistoryVideoOutcome recognizes verified terminal failures without exposing message content', () => {
  assert.deepEqual(inspectHistoryVideoOutcome({
    data: {
      messageList: [
        { role: 'assistant', type: 9, content: 'Video generation failed. Please try again.' },
      ],
    },
  }), { status: 'failed' });
  assert.deepEqual(inspectHistoryVideoOutcome({
    data: {
      messageList: [
        { role: 'assistant', type: 9, content: 'Video is still generating' },
      ],
    },
  }), { status: 'pending' });
});

test('extractHistoryVideoResult rejects arbitrary URLs and message types', () => {
  assert.throws(() => extractHistoryVideoResult({
    data: {
      messageList: [
        { role: 'assistant', type: 8, content: '<video src="https://cdn.oreateai.com/aivideo/videodownload/1.mp4"></video>' },
        { role: 'assistant', type: 9, content: '<video src="https://example.com/aivideo/videodownload/1.mp4"></video>' },
        { role: 'assistant', type: 9, content: '<video src="https://cdn.oreateai.com/other/1.mp4"></video>' },
      ],
    },
  }), /历史消息中没有有效 aiVideo/);
});