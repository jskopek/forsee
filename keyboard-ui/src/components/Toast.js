import React, { useEffect } from 'react';

const Toast = ({ message, onClose }) => {
  const isVisible = message && message !== '';

  useEffect(() => {
    if (isVisible) {
      // Always auto-close after 2 seconds
      const timer = setTimeout(() => {
        onClose();
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [isVisible, onClose]);

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 animate-fade-in">
      <div className="bg-gray-900/95 border border-gray-700 rounded-lg shadow-lg px-4 py-3 min-w-[200px] max-w-[400px]">
        <div className="text-white text-sm font-medium">
          {message}
        </div>
      </div>
    </div>
  );
};

export default Toast;

