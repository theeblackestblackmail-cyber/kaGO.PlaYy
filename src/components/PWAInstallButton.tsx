import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuideModal(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-2 rounded-lg border border-[#282B36] bg-[#121318] px-3 py-2 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48]/60 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="h-3.5 w-3.5 text-[#E11D48]" />
        <span>Install App</span>
      </button>

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
        >
          <div className="w-full max-w-md rounded-xl border border-[#1F2129] bg-[#0D0E12] p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#282B36] bg-[#15171E] text-[#E11D48]">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="pwa-install-title" className="font-display text-base font-bold text-[#F4F3F0]">
                    Install kaGO.PIaY
                  </h3>
                  <p className="text-xs text-[#8E929B]">Offline PWA &amp; Android SDK 34 Ready</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                aria-label="Close install instructions"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8E929B] hover:bg-[#1A1C24] hover:text-white transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-4 space-y-2 text-sm text-[#C7C9D1]">
                <p>1. Tap the Safari Share icon in your browser toolbar.</p>
                <p>2. Scroll down and select Add to Home Screen.</p>
                <p>3. Launch kaGO.PIaY directly with dark splash screen and offline synth stems.</p>
              </div>
            ) : (
              <div className="mt-4 space-y-2 text-sm text-[#C7C9D1]">
                <p>1. Open your browser address bar menu or settings.</p>
                <p>2. Choose Install kaGO.PIaY or Add to Home Screen.</p>
                <p className="text-xs text-[#8E929B]">
                  Service Worker offline caching and standalone dark splash manifest are active.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="mt-5 w-full rounded-lg bg-[#E11D48] py-2.5 text-sm font-semibold text-white hover:bg-[#BE123C] transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};
