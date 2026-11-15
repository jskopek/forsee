import React from 'react';

const TextInput = ({ text, onClear, onSpeak }) => {
  return (
    <div>
      <textarea className="w-full border border-gray-300 rounded p-2" value={text} readOnly />
      <div className="flex gap-2 mt-2">
        <button onClick={onClear} className="px-4 py-2 bg-white border border-gray-300 rounded hover:bg-gray-50">Clear</button>
        <button onClick={onSpeak} className="px-4 py-2 bg-white border border-gray-300 rounded hover:bg-gray-50">Play</button>
      </div>
    </div>
  );
};

export default TextInput;
