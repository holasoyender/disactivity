import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enUS from './locales/en-US.json';
import esES from './locales/es-ES.json';
import ptBR from './locales/pt-BR.json';

const resources = {
  'en-US': { translation: enUS },
  'es-ES': { translation: esES },
  'pt-BR': { translation: ptBR },
  // Fallback mappings for base language codes
  'en': { translation: enUS },
  'es': { translation: esES },
  'pt': { translation: ptBR },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en-US',
    supportedLngs: ['en-US', 'es-ES', 'pt-BR', 'en', 'es', 'pt'],
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    detection: {
      order: ['navigator', 'htmlTag', 'localStorage'],
      caches: ['localStorage'],
    },
  }).catch(console.error);

export default i18n;

