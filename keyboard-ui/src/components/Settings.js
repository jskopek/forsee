
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
    <div className="settings">
      <label htmlFor="dwell-time">Dwell Time (ms):</label>
      <input
        type="number"
        id="dwell-time"
        value={dwellTime}
        onChange={handleDwellTimeChange}
      />
      <button onClick={handleSave}>Save</button>
    </div>
  );
};

export default Settings;
