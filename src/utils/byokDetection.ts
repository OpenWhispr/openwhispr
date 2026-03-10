export const hasStoredByokKey = () =>
  !!(
    localStorage.getItem("openaiApiKey") ||
    localStorage.getItem("groqApiKey") ||
    localStorage.getItem("mistralApiKey") ||
    localStorage.getItem("sonioxApiKey") ||
    localStorage.getItem("customTranscriptionApiKey")
  );
