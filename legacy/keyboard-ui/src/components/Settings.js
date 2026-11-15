import React, { useState, useEffect } from 'react';

const Settings = ({ initialDwellTime, onDwellTimeChange }) => {
  const [dwellTime, setDwellTime] = useState(initialDwellTime);

  useEffect(() => {
    setDwellTime(initialDwellTime);
  }, [initialDwellTime]);

  const handleDwellTimeChange = (e) => {
    setDwellTime(e.target.value);
  };

  const handleSave = () => {
    onDwellTimeChange(dwellTime);
  };

  return (
    <div className="my-2 mx-auto w-[90%] flex items-center gap-2">
      <label htmlFor="dwell-time">Dwell Time (ms):</label>
      <input
        type="number"
        id="dwell-time"
        value={dwellTime}
        onChange={handleDwellTimeChange}
        className="w-[120px]"
      />
      <button onClick={handleSave}>Save</button>
    </div>
  );
};

export default Settings;
