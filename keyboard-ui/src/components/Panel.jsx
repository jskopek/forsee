/**
 * Panel Component
 *
 * A reusable collapsible panel for plugins.
 * Provides consistent styling and behavior across all plugins.
 */

import React from 'react';

const Panel = ({
  title,
  isExpanded = true,
  onToggle,
  children,
  loading = false,
  className = ''
}) => {
  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      {/* Panel header with toggle */}
      {onToggle && (
        <div
          className="flex items-center justify-between px-4 py-2 bg-bg-main border-b border-border-light cursor-pointer hover:bg-gray-700 transition-colors"
          onClick={onToggle}
        >
          <h3 className="text-white font-medium text-sm">{title}</h3>
          <button
            className="text-white text-xs px-2 py-1 rounded hover:bg-gray-600 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>
      )}

      {/* Panel content */}
      {isExpanded && (
        <div className="flex-1 min-h-0 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-main bg-opacity-75 z-10">
              <div className="flex items-center gap-2 text-white">
                <svg
                  className="animate-spin h-5 w-5"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Loading...</span>
              </div>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
};

export default Panel;
