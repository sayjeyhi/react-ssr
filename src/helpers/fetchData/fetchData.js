import Q from 'q'
import 'regenerator-runtime/runtime.js' // for async await, only used here

/**
 * Builds a promise to execute the matched fetchData method
 * @param {*} component - component with fetchData method/promose
 * @param {*} params - params of matched route to pass to fetchData
 */
const executeFetchData = (component, match, req, debug) => {
  return new Promise(async (resolve, reject) => {
    if (typeof component.fetchData !== 'function') {
      return reject(new Error('Fetch data not defined or not a function.'))
    }

    const fetch = component.fetchData({match, req})
    const keys = Object.keys(fetch || {}) || []
    const props = {}

    if (!keys.length) {
      try {
        let response

        try {
          response = await fetch
          const updatedKeys = Object.keys(response || {})
          updatedKeys.forEach((key, index) => {
            props[key] = response[key]
          })
        } catch (e) {
          // data fetch failed...
          console.warn('Fetch failed for', component.displayName)
          props.error = true
        }

        component.defaultProps = { ...component.defaultProps, ...props }
        resolve(component)
      } catch (error) {
        if (debug) {
          console.warn('Rejected in an array from fetchData. Component: ', component.displayName)
          console.warn('Error: ', error)
        }

        reject(component)
      }
    } else {
      const waitFor = [fetch, ...keys.map(key => fetch[key])]

      await Q.allSettled(waitFor)
        .then(responses => {
          responses.forEach((data, index) => {
            if (data.value) {
              props[keys[index]] = data.value
            } else {
              debug && console.warn(`Fetch #${index + 1} in ${component.displayName} failed.`)
            }
          })

          component.defaultProps = { ...component.defaultProps, ...props }
          resolve(component)
        })
        .catch(error => {
          if (debug) {
            console.warn('Rejected in an array from fetchData. Component: ', component.displayName)
            console.warn('Error: ', error)
          }

          reject(component)
        })
    }
  })
}

/**
 * Builds list of fetchData promise methods for each component
 * @param component - the current React component
 * @param params - contains our state
 * @returns {Array} promises - returns an array of promises, each a fetchData
 */
const fetchData = (component, match, req, debug = false, promises = []) => {
  if (component.fetchData) {
    component.defaultProps = component.defaultProps || {}
    promises.push(executeFetchData(component, match, req, debug))
  }

  if (component.ssrWaitsFor) {
    component.ssrWaitsFor.forEach(childComponent => {
      promises = fetchData(childComponent || childComponent.WrappedComponent, match, req, debug, promises)
    })
  }

  return promises
}

export { executeFetchData }
export default fetchData
