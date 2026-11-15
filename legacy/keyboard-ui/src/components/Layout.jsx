import React, { useState, Children, cloneElement } from 'react';
import Button from './Button';

const Panel = ({
  children,
  panelState,
  onToggle,
  title = '',
  name
}) => {
  // Calculate height based on panel state
  const getHeight = () => {
    if (panelState === 'expanded') return 'flex-1';
    if (panelState === 'minimized') return 'h-[20vh]';
    return 'flex-1'; // regular state - equal height
  };

  const getToggleIcon = () => {
    if (panelState === 'expanded') return '−';
    if (panelState === 'minimized') return '+';
    return '○';
  };

  return (
    <div className={`flex gap-0 ${getHeight()} min-h-0 transition-all duration-300`}>
      {/* Toggle button */}
      <Button
        icon={getToggleIcon()}
        color="blue"
        dwell={true}
        variant="minimal"
        onClick={onToggle}
        className="!w-[25px] !h-full flex-shrink-0 text-sm"
      />

      {/* Panel content */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
};

const Layout = ({ children }) => {
  // Initialize panel states based on children
  const [panelStates, setPanelStates] = useState(() => {
    const initialStates = {};
    Children.forEach(children, (child) => {
      if (child?.props?.name) {
        initialStates[child.props.name] = 'regular';
      }
    });
    return initialStates;
  });

  const handlePanelToggle = (panelName) => {
    setPanelStates((prev) => {
      const currentState = prev[panelName];

      // If clicking an expanded panel, go back to regular
      if (currentState === 'expanded') {
        const newStates = {};
        Object.keys(prev).forEach(key => {
          newStates[key] = 'regular';
        });
        return newStates;
      }

      // If clicking a minimized panel, go back to regular
      if (currentState === 'minimized') {
        const newStates = {};
        Object.keys(prev).forEach(key => {
          newStates[key] = 'regular';
        });
        return newStates;
      }

      // If clicking a regular panel, expand it and minimize others
      const newStates = {};
      Object.keys(prev).forEach(key => {
        newStates[key] = key === panelName ? 'expanded' : 'minimized';
      });
      return newStates;
    });
  };

  return (
    <div className="flex-1 flex flex-col gap-0 p-0 min-h-0">
      {Children.map(children, (child) => {
        if (!child?.props?.name) return child;

        return cloneElement(child, {
          panelState: panelStates[child.props.name],
          onToggle: () => handlePanelToggle(child.props.name)
        });
      })}
    </div>
  );
};

// Attach Panel as a subcomponent
Layout.Panel = Panel;

export default Layout;
