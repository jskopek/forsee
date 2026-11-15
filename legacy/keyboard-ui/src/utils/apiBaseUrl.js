export const getApiBaseUrl = () =>
  process.env.REACT_APP_API_BASE_URL ||
  window.API_BASE_URL ||
  (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

export default getApiBaseUrl;
