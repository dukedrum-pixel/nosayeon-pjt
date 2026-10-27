const edgeBase = 'https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/nosayeon-result-api';
export function resultApiUrl(path, configuredBase = '') {
  if (!/^\/api\/(result|audio|download|restore)\?/.test(path) || (configuredBase !== '' && configuredBase !== edgeBase)) throw new Error('invalid_result_api');
  return `${configuredBase}${path}`;
}
