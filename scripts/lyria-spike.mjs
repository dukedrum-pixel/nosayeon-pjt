import { parseArgs } from 'node:util';
import { createClient, runSpike, SpikeError, DEFAULT_PROMPT } from '../src/lyria-spike.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'allow-paid-call': { type: 'boolean', default: false },
    resume: { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help || (!values['allow-paid-call'] && !values.resume)) {
    console.log('Lyria 3.5 동일 음원 복구 검증 (지금은 API를 호출하지 않았어)\n'
      + '생성 1회 + 재조회: npm run spike -- --allow-paid-call\n'
      + '동일 건 재조회만: npm run spike -- --resume artifacts/lyria/run-XXXXXX\n'
      + '필요 설정: GEMINI_API_KEY, Google API 네트워크 허용\n'
      + `테스트 프롬프트: ${DEFAULT_PROMPT}`);
    return;
  }
  if (values.resume && values['allow-paid-call']) throw new SpikeError('resume과 새 생성 옵션은 함께 사용할 수 없어.');
  const client = createClient({ apiKey: process.env.GEMINI_API_KEY });
  const { dir, report } = await runSpike({ client, resume: values.resume, onProgress: console.log });
  console.log(`검증 결과: ${report.result}\n결과 파일: ${dir}/report.json`);
  if (report.result !== 'identical') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof SpikeError ? error.message : '검증 중 로컬 처리 오류가 발생했어. 로컬 파일과 실행 설정을 확인해. 자동 재생성하지 않아.');
  process.exitCode = 1;
});
