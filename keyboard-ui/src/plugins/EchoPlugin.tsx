/**
 * Echo Plugin (Example/Test)
 *
 * A simple example plugin that echoes back what the user types.
 * Demonstrates the plugin architecture without complex LLM logic.
 */

import React, { useState, useEffect } from 'react';
import type { Plugin } from './plugin-types';
import Panel from '../components/Panel';

const EchoPlugin: Plugin = {
  metadata: {
    id: 'example.echo',
    name: 'Echo Test',
    description: 'A simple test plugin that echoes your input',
    version: '1.0.0',
    author: 'Forsee',
    icon: '📣',
  },

  settings: {
    schema: [
      {
        key: 'prefix',
        label: 'Echo Prefix',
        type: 'string',
        description: 'Prefix to add before echoed text',
        default: 'Echo: ',
      },
      {
        key: 'uppercase',
        label: 'Uppercase',
        type: 'boolean',
        description: 'Convert to uppercase',
        default: false,
      },
    ],
    defaults: {
      prefix: 'Echo: ',
      uppercase: false,
    },
  },

  Component: ({ context }) => {
    const [echoText, setEchoText] = useState('');

    useEffect(() => {
      const { keyboardPrefix, settings } = context;
      let text = keyboardPrefix;

      if (settings.uppercase) {
        text = text.toUpperCase();
      }

      setEchoText(settings.prefix + text);
    }, [context.keyboardPrefix, context.settings]);

    return (
      <Panel title="Echo Test">
        <div className="flex-1 flex items-center justify-center bg-bg-main">
          <div className="text-white text-xl p-4">
            {echoText || 'Type something...'}
          </div>
        </div>
      </Panel>
    );
  },
};

export default EchoPlugin;
